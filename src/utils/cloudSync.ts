import {
  database,
  auth,
  FirebaseUser,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  off,
  firestore,
  fsDoc,
  fsGetDoc,
  fsSetDoc,
  fsUpdateDoc,
  fsDeleteDoc,
  fsCollection,
  fsQuery,
  fsWhere,
  fsGetDocs,
  fsOnSnapshot,
  fsGetDocFromServer,
  fsWriteBatch,
  testFirestoreConnection,
  handleFirestoreError,
  OperationType,
  sanitizeSchoolCode as sanitizeSchoolCodeUtil
} from './firebase';
import {
  SchoolProfile,
  ClassInfo,
  ClassItem,
  TeacherInfo,
  Student,
  AttendanceRecord,
  Exam,
  ExamMarksRecord,
  Reminder,
  AppSettings,
  TeacherAccount,
  TeacherActivityItem,
  SchoolAdminAccount,
  TimetableSlot,
  PrincipalBroadcast,
  AuditLogItem,
  SynthesisReport,
  ConnectedDevice
} from '../types';
import { StorageService, registerStorageMutationListener, setStorageMutationSilenced } from './storage';

export interface ClassScopedData {
  students: Student[];
  attendance: AttendanceRecord[];
  exams: Exam[];
  examMarksMap: Record<string, ExamMarksRecord>;
}

export interface UserCloudBundle {
  version: string;
  lastSyncedAt: string;
  deviceId?: string;
  schoolProfile: SchoolProfile;
  teacherInfo: TeacherInfo;
  classesCatalog: ClassItem[];
  activeClassId: string;
  classInfo: ClassInfo;
  reminders: Reminder[];
  settings: AppSettings;
  teacherAccounts: TeacherAccount[];
  schoolAdmins?: SchoolAdminAccount[];
  timetables?: TimetableSlot[];
  timetablePrefs?: Record<string, { periodTimings?: any[]; includeSaturday?: boolean }>;
  classData: Record<string, ClassScopedData>;
  students?: Student[];
  attendance?: AttendanceRecord[];
  exams?: Exam[];
  examMarks?: Record<string, ExamMarksRecord>;
}

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline' | 'quota-exceeded';
export type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';

export type SyncListener = (
  status: SyncStatus,
  lastSyncedAt?: string,
  userEmail?: string,
  report?: SynthesisReport | null,
  saveState?: SaveState
) => void;

class CloudSyncManager {
  private currentStatus: SyncStatus = 'idle';
  private saveState: SaveState = 'idle';
  private savedResetTimer: any = null;
  private retryTimer: any = null;
  private retryAttempt: number = 0;
  private lastSyncedAt: string | undefined = undefined;
  private listeners: Set<SyncListener> = new Set();
  private debounceTimer: any = null;
  private unsubscribeSnapshot: (() => void) | null = null;
  private unsubscribeEmailSnapshot: (() => void) | null = null;
  private unsubscribeFirestoreEmailSnapshot: (() => void) | null = null;
  private unsubscribeFirestoreUserSnapshot: (() => void) | null = null;
  private unsubscribeBroadcastsSnapshot: (() => void) | null = null;
  private isApplyingRemoteUpdate = false;
  private lastSavedPayloadHash: string = '';
  private quotaExhaustedUntil: number = 0;
  private activeSyncEmail: string | undefined = undefined;
  private lastSynthesisReport: SynthesisReport | null = null;
  private broadcastChannel: BroadcastChannel | null = null;
  private deviceId: string = (() => {
    let id = '';
    try {
      id = localStorage.getItem('hss_client_device_id') || '';
    } catch {}
    if (!id) {
      id = 'dev_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
      try {
        localStorage.setItem('hss_client_device_id', id);
      } catch {}
    }
    return id;
  })();

  constructor() {
    this.lastSyncedAt = localStorage.getItem('hss_last_cloud_sync') || undefined;
    this.activeSyncEmail = localStorage.getItem('hss_active_sync_email') || undefined;

    try {
      const storedReport = localStorage.getItem('hss_last_synthesis_report');
      if (storedReport) {
        this.lastSynthesisReport = JSON.parse(storedReport);
      }
    } catch {}

    // Check for pending offline changes from previous session
    if (typeof localStorage !== 'undefined' && localStorage.getItem('hss_pending_offline_sync') === 'true') {
      this.saveState = 'offline';
      setTimeout(() => this.flushPendingOfflineSync(), 1500);
    }

    // Real-time Storage to Cloud Hook: Automatically trigger sync whenever local data is modified
    registerStorageMutationListener(() => {
      if (!this.isApplyingRemoteUpdate) {
        this.scheduleAutoSync();
      }
    });

    // Initialize BroadcastChannel for 0ms same-origin multi-tab instant synthesis
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.broadcastChannel = new BroadcastChannel('hss_instant_data_synthesis');
        this.broadcastChannel.onmessage = (event) => {
          if (!event?.data) return;
          const { type, report, deviceId } = event.data;
          if (deviceId === this.deviceId && (type === 'DATA_SYNTHESIS_APPLIED' || type === 'STORAGE_MUTATED')) {
            if (report) this.lastSynthesisReport = report;
            this.notify('synced');
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('hss:cloud-sync-synthesized', { detail: { report, crossTab: true } }));
            }
          }
        };
      } catch (e) {
        console.warn('BroadcastChannel initialization note:', e);
      }
    }

    // Multi-tab storage event synchronization
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key && e.key.startsWith('hss_') && !this.isApplyingRemoteUpdate) {
          setTimeout(() => {
            this.notify(this.getStatus());
            window.dispatchEvent(new CustomEvent('hss:cloud-sync-synthesized', { detail: { crossTab: true } }));
          }, 15);
        }
      });

      // Background to foreground catch-up synthesis
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && !this.isApplyingRemoteUpdate) {
            this.scheduleCatchUpSync();
          }
        });
      }
      window.addEventListener('focus', () => {
        if (!this.isApplyingRemoteUpdate) {
          this.scheduleCatchUpSync();
        }
      });
      window.addEventListener('online', () => {
        console.log('[CloudSync] Network online restored. Flushing offline sync queue...');
        this.notify('syncing');
        this.flushPendingOfflineSync().catch(() => {});
        this.forceDeepSynthesis().catch(() => {});
      });
      window.addEventListener('offline', () => {
        console.log('[CloudSync] Network offline detected. Switching to offline safe persistence.');
        this.setSaveState('offline');
        this.notify('offline');
      });
    }
  }

  public getDeviceId(): string {
    return this.deviceId;
  }

  public getSynthesisReport(): SynthesisReport | null {
    return this.lastSynthesisReport;
  }

  public detectDevicePlatform(): 'Android APK' | 'Web Browser' | 'PWA Mobile' | 'Mobile Browser' {
    if (typeof window === 'undefined') return 'Web Browser';
    const hasAndroidBridge = !!(window as any).AndroidBridge;
    const isWv = navigator.userAgent.includes('wv') || (navigator.userAgent.includes('Android') && navigator.userAgent.includes('Version/'));
    if (hasAndroidBridge || isWv) {
      return 'Android APK';
    }
    const isStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    if (isStandalone || (navigator as any).standalone) {
      return 'PWA Mobile';
    }
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
      return 'Mobile Browser';
    }
    return 'Web Browser';
  }

  public getDeviceCustomName(): string {
    try {
      const stored = localStorage.getItem('hss_device_custom_name');
      if (stored) return stored;
    } catch {}
    const platform = this.detectDevicePlatform();
    if (platform === 'Android APK') return 'Android Mobile APK';
    if (platform === 'PWA Mobile') return 'Mobile PWA App';
    if (typeof navigator !== 'undefined') {
      if (navigator.userAgent.includes('Windows')) return 'Windows Workstation';
      if (navigator.userAgent.includes('Macintosh')) return 'Mac Desktop / Laptop';
      if (navigator.userAgent.includes('Linux')) return 'Linux Device';
      if (navigator.userAgent.includes('Android')) return 'Android Web Browser';
      if (navigator.userAgent.includes('iPhone') || navigator.userAgent.includes('iPad')) return 'iOS Safari Device';
    }
    return 'Web Browser Device';
  }

  public setDeviceCustomName(name: string) {
    if (!name || !name.trim()) return;
    try {
      localStorage.setItem('hss_device_custom_name', name.trim());
      this.scheduleAutoSync(true);
    } catch {}
  }

  private scheduleCatchUpSync() {
    const user = auth?.currentUser;
    const email = this.getActiveSyncEmail();
    if (!user && !email) return;

    if (database && email) {
      const emailKey = this.sanitizeEmailKey(email);
      get(ref(database, 'email_accounts/' + emailKey + '/lastSyncedAt')).then(snap => {
        if (snap.exists()) {
          const remoteTime = snap.val();
          if (remoteTime && remoteTime !== this.lastSyncedAt) {
            this.forceDeepSynthesis().catch(() => {});
          }
        }
      }).catch(() => {});
    }
  }

  public sanitizeEmailKey(email: string): string {
    return (email || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  }

  public sanitizeSchoolCode(schoolCode?: string, fallback: string = 'SSHSS@111213'): string {
    return sanitizeSchoolCodeUtil(schoolCode, fallback);
  }

  public getStatus(): SyncStatus {
    if (this.quotaExhaustedUntil > Date.now()) {
      return 'quota-exceeded';
    }
    return this.currentStatus;
  }

  public getLastSyncedAt(): string | undefined {
    return this.lastSyncedAt;
  }

  public getActiveSyncEmail(): string | undefined {
    return this.activeSyncEmail || localStorage.getItem('hss_active_sync_email') || auth?.currentUser?.email || undefined;
  }

  public setActiveSyncEmail(email?: string) {
    if (email) {
      const clean = email.trim().toLowerCase();
      this.activeSyncEmail = clean;
      localStorage.setItem('hss_active_sync_email', clean);
    } else {
      this.activeSyncEmail = undefined;
      localStorage.removeItem('hss_active_sync_email');
    }
    this.notify(this.getStatus());
  }

  public getSaveState(): SaveState {
    return this.saveState;
  }

  public setSaveState(state: SaveState) {
    this.saveState = state;
    if (this.savedResetTimer) {
      clearTimeout(this.savedResetTimer);
      this.savedResetTimer = null;
    }
    if (state === 'saved') {
      this.savedResetTimer = setTimeout(() => {
        if (this.saveState === 'saved') {
          this.saveState = 'idle';
          this.notify(this.getStatus());
        }
      }, 2500);
    }
    this.notify(this.getStatus());

    if (typeof window !== 'undefined') {
      const dispatchStateEvent = () => {
        window.dispatchEvent(
          new CustomEvent('hss:cloud-save-state', {
            detail: { state: this.saveState, lastSyncedAt: this.lastSyncedAt }
          })
        );
      };
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(dispatchStateEvent);
      } else {
        setTimeout(dispatchStateEvent, 0);
      }
    }
  }

  public async flushPendingOfflineSync(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.setSaveState('offline');
      return false;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAttempt = 0;
    const ok = await this.pushToCloud();
    if (ok) {
      try {
        localStorage.removeItem('hss_pending_offline_sync');
      } catch {}
    }
    return ok;
  }

  private scheduleOfflineRetry() {
    if (this.retryTimer) return;
    const delays = [2000, 5000, 10000, 20000];
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)];
    this.retryAttempt++;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        const ok = await this.pushToCloud();
        if (ok) {
          try {
            localStorage.removeItem('hss_pending_offline_sync');
          } catch {}
          this.retryAttempt = 0;
        } else {
          this.scheduleOfflineRetry();
        }
      } else {
        this.scheduleOfflineRetry();
      }
    }, delay);
  }

  public addListener(listener: SyncListener) {
    this.listeners.add(listener);
    listener(this.getStatus(), this.lastSyncedAt, this.getActiveSyncEmail(), this.lastSynthesisReport, this.saveState);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(status: SyncStatus, error?: any) {
    this.currentStatus = status;
    const userEmail = this.getActiveSyncEmail();
    this.listeners.forEach(fn => fn(this.getStatus(), this.lastSyncedAt, userEmail, this.lastSynthesisReport, this.saveState));
  }

  public gatherAllLocalData(): UserCloudBundle {
    const classes = StorageService.getClassesList();
    const activeClassId = StorageService.getActiveClassId();
    const classData: Record<string, ClassScopedData> = {};

    classes.forEach(c => {
      classData[c.id] = {
        students: StorageService.getStudents(c.id),
        attendance: StorageService.getAttendance(c.id),
        exams: StorageService.getExams(c.id),
        examMarksMap: StorageService.getExamMarksMap(c.id)
      };
    });

    const activeStudents = StorageService.getStudents(activeClassId);
    const activeAttendance = StorageService.getAttendance(activeClassId);
    const activeExams = StorageService.getExams(activeClassId);
    const activeMarks = StorageService.getExamMarksMap(activeClassId);

    return {
      version: '2.5.0',
      lastSyncedAt: new Date().toISOString(),
      deviceId: this.deviceId,
      schoolProfile: StorageService.getSchoolProfile(),
      teacherInfo: StorageService.getTeacherInfo(),
      classesCatalog: classes,
      activeClassId: activeClassId,
      classInfo: StorageService.getClassInfo(activeClassId),
      reminders: StorageService.getReminders(),
      settings: StorageService.getSettings(),
      teacherAccounts: StorageService.getTeacherAccounts(),
      schoolAdmins: StorageService.getSchoolAdmins(),
      timetables: StorageService.getTimetables(),
      timetablePrefs: StorageService.getAllTimetablePrefs(),
      classData,
      students: activeStudents,
      attendance: activeAttendance,
      exams: activeExams,
      examMarks: activeMarks
    };
  }

  // -------------------------------------------------------------
  // INTELLIGENT MULTI-DEVICE DATA SYNTHESIS ALGORITHMS
  // -------------------------------------------------------------

  public synthesizeClasses(local: ClassItem[] = [], remote: ClassItem[] = []): ClassItem[] {
    const map = new Map<string, ClassItem>();
    (remote || []).forEach(c => {
      if (c && c.id) map.set(c.id, { ...c });
    });
    (local || []).forEach(c => {
      if (c && c.id) {
        if (!map.has(c.id)) {
          map.set(c.id, { ...c });
        } else {
          const existing = map.get(c.id)!;
          map.set(c.id, {
            ...existing,
            ...c,
            id: c.id,
            className: c.className || existing.className,
            standard: c.standard || existing.standard,
            section: c.section || existing.section,
            stream: c.stream || existing.stream,
            academicYear: c.academicYear || existing.academicYear,
            classStrength: Math.max(c.classStrength || 0, existing.classStrength || 0)
          });
        }
      }
    });
    return Array.from(map.values());
  }

  public synthesizeStudentLists(local: Student[] = [], remote: Student[] = []): Student[] {
    const studentMap = new Map<string, Student>();
    const rollMap = new Map<number, string>(); // rollNo -> studentId

    const registerStudent = (st: Student) => {
      if (!st || !st.id) return;
      const rollNum = typeof st.rollNo === 'number' ? st.rollNo : parseInt(st.rollNo as any, 10) || 0;

      if (rollNum > 0 && rollMap.has(rollNum)) {
        const existingId = rollMap.get(rollNum)!;
        const existing = studentMap.get(existingId)!;
        studentMap.set(existingId, {
          ...existing,
          ...st,
          id: existingId,
          name: st.name || existing.name,
          rollNo: rollNum,
          admissionNo: st.admissionNo || existing.admissionNo,
          phone: st.phone || existing.phone,
          parentName: st.parentName || existing.parentName,
          parentPhone: st.parentPhone || existing.parentPhone,
          guardianPhone: st.guardianPhone || existing.guardianPhone,
          division: st.division || existing.division,
          gender: st.gender || existing.gender,
          dob: st.dob || existing.dob,
          address: st.address || existing.address,
          bloodGroup: st.bloodGroup || existing.bloodGroup,
          notes: st.notes || existing.notes,
          photoUrl: st.photoUrl || existing.photoUrl,
          avatar: st.avatar || existing.avatar,
          createdAt: existing.createdAt || st.createdAt
        });
        return;
      }

      if (studentMap.has(st.id)) {
        const existing = studentMap.get(st.id)!;
        studentMap.set(st.id, {
          ...existing,
          ...st,
          name: st.name || existing.name,
          rollNo: rollNum || existing.rollNo,
          admissionNo: st.admissionNo || existing.admissionNo,
          phone: st.phone || existing.phone,
          parentName: st.parentName || existing.parentName,
          parentPhone: st.parentPhone || existing.parentPhone,
          guardianPhone: st.guardianPhone || existing.guardianPhone,
          division: st.division || existing.division,
          gender: st.gender || existing.gender,
          dob: st.dob || existing.dob,
          address: st.address || existing.address,
          bloodGroup: st.bloodGroup || existing.bloodGroup,
          notes: st.notes || existing.notes,
          photoUrl: st.photoUrl || existing.photoUrl,
          avatar: st.avatar || existing.avatar,
          createdAt: existing.createdAt || st.createdAt
        });
      } else {
        studentMap.set(st.id, { ...st, rollNo: rollNum });
        if (rollNum > 0) rollMap.set(rollNum, st.id);
      }
    };

    (remote || []).forEach(registerStudent);
    (local || []).forEach(registerStudent);

    const result = Array.from(studentMap.values());
    result.sort((a, b) => a.rollNo - b.rollNo);
    return result;
  }

  public synthesizeAttendanceRecords(local: AttendanceRecord[] = [], remote: AttendanceRecord[] = []): AttendanceRecord[] {
    const attendanceMap = new Map<string, AttendanceRecord>();

    const mergeRecord = (rec: AttendanceRecord) => {
      if (!rec || !rec.date) return;
      const key = rec.date.trim();
      if (!attendanceMap.has(key)) {
        attendanceMap.set(key, { ...rec });
      } else {
        const existing = attendanceMap.get(key)!;
        const presentSet = new Set<string>([
          ...(existing.presentStudentIds || []),
          ...(rec.presentStudentIds || [])
        ]);
        const absentSet = new Set<string>([
          ...(existing.absentStudentIds || []),
          ...(rec.absentStudentIds || [])
        ]);
        presentSet.forEach(id => absentSet.delete(id));

        attendanceMap.set(key, {
          ...existing,
          ...rec,
          id: existing.id || rec.id,
          date: key,
          presentStudentIds: Array.from(presentSet),
          absentStudentIds: Array.from(absentSet),
          notes: rec.notes || existing.notes,
          savedAt: rec.savedAt || existing.savedAt || new Date().toISOString()
        });
      }
    };

    (remote || []).forEach(mergeRecord);
    (local || []).forEach(mergeRecord);

    const result = Array.from(attendanceMap.values());
    result.sort((a, b) => b.date.localeCompare(a.date));
    return result;
  }

  public synthesizeExamLists(local: Exam[] = [], remote: Exam[] = []): Exam[] {
    const examMap = new Map<string, Exam>();

    const mergeExam = (ex: Exam) => {
      if (!ex || !ex.id) return;
      if (!examMap.has(ex.id)) {
        examMap.set(ex.id, { ...ex });
      } else {
        const existing = examMap.get(ex.id)!;
        const subjectMap = new Map<string, any>();
        (existing.subjects || []).forEach(s => subjectMap.set(s.id || s.name, s));
        (ex.subjects || []).forEach(s => {
          const k = s.id || s.name;
          if (subjectMap.has(k)) {
            subjectMap.set(k, { ...subjectMap.get(k), ...s });
          } else {
            subjectMap.set(k, { ...s });
          }
        });

        examMap.set(ex.id, {
          ...existing,
          ...ex,
          id: ex.id,
          name: ex.name || existing.name,
          subjects: Array.from(subjectMap.values())
        });
      }
    };

    (remote || []).forEach(mergeExam);
    (local || []).forEach(mergeExam);

    return Array.from(examMap.values());
  }

  public synthesizeExamMarksMap(
    localMap: Record<string, ExamMarksRecord> = {},
    remoteMap: Record<string, ExamMarksRecord> = {}
  ): Record<string, ExamMarksRecord> {
    const result: Record<string, ExamMarksRecord> = {};
    const allExamIds = Array.from(new Set([...Object.keys(localMap || {}), ...Object.keys(remoteMap || {})]));

    allExamIds.forEach(examId => {
      const localRec = localMap?.[examId];
      const remoteRec = remoteMap?.[examId];

      if (localRec && !remoteRec) {
        result[examId] = localRec;
      } else if (!localRec && remoteRec) {
        result[examId] = remoteRec;
      } else if (localRec && remoteRec) {
        const mergedMarks: Record<string, any> = {};
        const allStudentIds = Array.from(new Set([
          ...Object.keys(localRec.marks || {}),
          ...Object.keys(remoteRec.marks || {})
        ]));

        allStudentIds.forEach(studentId => {
          const localStMarks = localRec.marks?.[studentId];
          const remoteStMarks = remoteRec.marks?.[studentId];

          if (localStMarks && !remoteStMarks) {
            mergedMarks[studentId] = localStMarks;
          } else if (!localStMarks && remoteStMarks) {
            mergedMarks[studentId] = remoteStMarks;
          } else if (localStMarks && remoteStMarks) {
            const mergedSubjectMarks: Record<string, number | null> = {
              ...(localStMarks.marks || {}),
              ...(remoteStMarks.marks || {})
            };
            const mergedAbsent: Record<string, boolean> = {
              ...(localStMarks.isAbsent || {}),
              ...(remoteStMarks.isAbsent || {})
            };

            const total = Object.values(mergedSubjectMarks).reduce((acc: number, val) => {
              return acc + (typeof val === 'number' ? val : 0);
            }, 0);

            mergedMarks[studentId] = {
              ...localStMarks,
              ...remoteStMarks,
              studentId,
              marks: mergedSubjectMarks,
              isAbsent: mergedAbsent,
              totalObtained: total || localStMarks.totalObtained || remoteStMarks.totalObtained
            };
          }
        });

        result[examId] = {
          ...localRec,
          ...remoteRec,
          examId,
          marks: mergedMarks,
          updatedAt: new Date().toISOString()
        };
      }
    });

    return result;
  }

  public synthesizeTimetableSlots(local: TimetableSlot[] = [], remote: TimetableSlot[] = []): TimetableSlot[] {
    const slotMap = new Map<string, TimetableSlot>();
    (remote || []).forEach(s => {
      if (s && s.id) slotMap.set(s.id, { ...s });
    });
    (local || []).forEach(s => {
      if (s && s.id) {
        if (!slotMap.has(s.id)) {
          slotMap.set(s.id, { ...s });
        } else {
          slotMap.set(s.id, { ...slotMap.get(s.id)!, ...s, id: s.id });
        }
      }
    });
    return Array.from(slotMap.values());
  }

  public synthesizeRemindersList(local: Reminder[] = [], remote: Reminder[] = []): Reminder[] {
    const reminderMap = new Map<string, Reminder>();
    (remote || []).forEach(r => {
      if (r && r.id) reminderMap.set(r.id, { ...r });
    });
    (local || []).forEach(r => {
      if (r && r.id) {
        if (!reminderMap.has(r.id)) {
          reminderMap.set(r.id, { ...r });
        } else {
          const existing = reminderMap.get(r.id)!;
          reminderMap.set(r.id, {
            ...existing,
            ...r,
            id: r.id,
            isCompleted: existing.isCompleted || r.isCompleted
          });
        }
      }
    });
    const res = Array.from(reminderMap.values());
    res.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return res;
  }

  public synthesizeDataBundle(
    local: UserCloudBundle,
    remote: Partial<UserCloudBundle>,
    sourceDeviceId?: string
  ): { synthesized: UserCloudBundle; report: SynthesisReport } {
    const synthesizedClasses = this.synthesizeClasses(local.classesCatalog, remote.classesCatalog);

    // Synthesize classScopedData
    const synthesizedClassData: Record<string, ClassScopedData> = {};
    const allClassesIds = Array.from(new Set([
      ...synthesizedClasses.map(c => c.id),
      ...Object.keys(local.classData || {}),
      ...Object.keys(remote.classData || {})
    ]));

    let totalStudentsSynthesized = 0;
    let totalAttendanceSynthesized = 0;
    let totalExamsSynthesized = 0;
    let totalMarksSynthesized = 0;

    allClassesIds.forEach(cid => {
      const localScoped = local.classData?.[cid] || {
        students: cid === local.activeClassId ? (local.students || []) : [],
        attendance: cid === local.activeClassId ? (local.attendance || []) : [],
        exams: cid === local.activeClassId ? (local.exams || []) : [],
        examMarksMap: cid === local.activeClassId ? (local.examMarks || {}) : {}
      };

      const remoteScoped = remote.classData?.[cid] || {
        students: cid === remote.activeClassId ? (remote.students || []) : [],
        attendance: cid === remote.activeClassId ? (remote.attendance || []) : [],
        exams: cid === remote.activeClassId ? (remote.exams || []) : [],
        examMarksMap: cid === remote.activeClassId ? (remote.examMarks || {}) : {}
      };

      const synthStudents = this.synthesizeStudentLists(localScoped.students, remoteScoped.students);
      const synthAttendance = this.synthesizeAttendanceRecords(localScoped.attendance, remoteScoped.attendance);
      const synthExams = this.synthesizeExamLists(localScoped.exams, remoteScoped.exams);
      const synthMarks = this.synthesizeExamMarksMap(localScoped.examMarksMap, remoteScoped.examMarksMap);

      synthesizedClassData[cid] = {
        students: synthStudents,
        attendance: synthAttendance,
        exams: synthExams,
        examMarksMap: synthMarks
      };

      totalStudentsSynthesized += synthStudents.length;
      totalAttendanceSynthesized += synthAttendance.length;
      totalExamsSynthesized += synthExams.length;
      totalMarksSynthesized += Object.keys(synthMarks).length;
    });

    const synthesizedTimetables = this.synthesizeTimetableSlots(local.timetables, remote.timetables);
    const synthesizedReminders = this.synthesizeRemindersList(local.reminders, remote.reminders);

    // Synthesize teacher accounts & school admins
    const teacherAccountsMap = new Map<string, TeacherAccount>();
    (remote.teacherAccounts || []).forEach(t => t?.id && teacherAccountsMap.set(t.id, t));
    (local.teacherAccounts || []).forEach(t => t?.id && teacherAccountsMap.set(t.id, { ...teacherAccountsMap.get(t.id), ...t }));

    const schoolAdminsMap = new Map<string, SchoolAdminAccount>();
    (remote.schoolAdmins || []).forEach(a => a?.id && schoolAdminsMap.set(a.id, a));
    (local.schoolAdmins || []).forEach(a => a?.id && schoolAdminsMap.set(a.id, { ...schoolAdminsMap.get(a.id), ...a }));

    const activeCid = remote.activeClassId || local.activeClassId || synthesizedClasses[0]?.id || '';

    const synthesized: UserCloudBundle = {
      version: '2.5.0',
      lastSyncedAt: new Date().toISOString(),
      deviceId: this.deviceId,
      schoolProfile: { ...local.schoolProfile, ...(remote.schoolProfile || {}) },
      teacherInfo: { ...local.teacherInfo, ...(remote.teacherInfo || {}) },
      classesCatalog: synthesizedClasses,
      activeClassId: activeCid,
      classInfo: { ...local.classInfo, ...(remote.classInfo || {}) },
      reminders: synthesizedReminders,
      settings: { ...local.settings, ...(remote.settings || {}) },
      teacherAccounts: Array.from(teacherAccountsMap.values()),
      schoolAdmins: Array.from(schoolAdminsMap.values()),
      timetables: synthesizedTimetables,
      timetablePrefs: { ...(local.timetablePrefs || {}), ...(remote.timetablePrefs || {}) },
      classData: synthesizedClassData,
      students: synthesizedClassData[activeCid]?.students || [],
      attendance: synthesizedClassData[activeCid]?.attendance || [],
      exams: synthesizedClassData[activeCid]?.exams || [],
      examMarks: synthesizedClassData[activeCid]?.examMarksMap || {}
    };

    const report: SynthesisReport = {
      studentsSynthesized: totalStudentsSynthesized,
      attendanceSynthesized: totalAttendanceSynthesized,
      examsSynthesized: totalExamsSynthesized,
      examMarksSynthesized: totalMarksSynthesized,
      classesSynthesized: synthesizedClasses.length,
      timetablesSynthesized: synthesizedTimetables.length,
      remindersSynthesized: synthesizedReminders.length,
      timestamp: new Date().toISOString(),
      sourceDeviceId: sourceDeviceId || remote.deviceId || 'cloud'
    };

    return { synthesized, report };
  }

  public applyCloudBundle(bundle: Partial<UserCloudBundle>, sourceDeviceId?: string): SynthesisReport {
    this.isApplyingRemoteUpdate = true;
    setStorageMutationSilenced(true);
    try {
      const local = this.gatherAllLocalData();
      const { synthesized, report } = this.synthesizeDataBundle(local, bundle, sourceDeviceId);

      if (synthesized.schoolProfile) {
        StorageService.saveSchoolProfile(synthesized.schoolProfile);
      }
      if (synthesized.teacherInfo) {
        StorageService.saveTeacherInfo(synthesized.teacherInfo);
      }
      if (synthesized.classesCatalog && Array.isArray(synthesized.classesCatalog) && synthesized.classesCatalog.length > 0) {
        StorageService.saveClassesList(synthesized.classesCatalog);
      }

      const session = StorageService.getAuthSession();
      const currentTeacher = session.currentTeacher;
      const targetClassId = synthesized.activeClassId || 
        StorageService.getActiveClassId(currentTeacher?.id || currentTeacher?.uid, currentTeacher?.email);
      if (targetClassId) {
        StorageService.setActiveClassId(targetClassId);
      }
      if (synthesized.classInfo) {
        StorageService.saveClassInfo(synthesized.classInfo, targetClassId);
      }
      if (synthesized.reminders) {
        StorageService.saveReminders(synthesized.reminders);
      }
      if (synthesized.settings) {
        StorageService.saveSettings(synthesized.settings);
      }
      if (synthesized.teacherAccounts && synthesized.teacherAccounts.length > 0) {
        StorageService.saveTeacherAccounts(synthesized.teacherAccounts);
      }
      if (synthesized.schoolAdmins && synthesized.schoolAdmins.length > 0) {
        StorageService.saveSchoolAdmins(synthesized.schoolAdmins);
      }
      if (synthesized.timetables) {
        StorageService.saveTimetables(synthesized.timetables);
      }
      if (synthesized.timetablePrefs && Object.keys(synthesized.timetablePrefs).length > 0) {
        StorageService.saveAllTimetablePrefs(synthesized.timetablePrefs);
      }

      if (synthesized.classData) {
        Object.entries(synthesized.classData).forEach(([classId, data]) => {
          if (data) {
            StorageService.saveStudents(data.students || [], classId);
            StorageService.saveAttendance(data.attendance || [], classId);
            StorageService.saveExams(data.exams || [], classId);
            StorageService.saveExamMarksMap(data.examMarksMap || {}, classId);
          }
        });

        // Ensure active class scoped data is also set to default active storage
        if (targetClassId && synthesized.classData[targetClassId]) {
          const activeScoped = synthesized.classData[targetClassId];
          StorageService.saveStudents(activeScoped.students || []);
          StorageService.saveAttendance(activeScoped.attendance || []);
          StorageService.saveExams(activeScoped.exams || []);
          StorageService.saveExamMarksMap(activeScoped.examMarksMap || {});
        }
      }

      if (bundle.lastSyncedAt) {
        this.lastSyncedAt = bundle.lastSyncedAt;
        localStorage.setItem('hss_last_cloud_sync', bundle.lastSyncedAt);
      }

      this.lastSynthesisReport = report;
      try {
        localStorage.setItem('hss_last_synthesis_report', JSON.stringify(report));
      } catch {}

      // Broadcast across open browser tabs / windows in 0ms
      if (this.broadcastChannel) {
        try {
          this.broadcastChannel.postMessage({
            type: 'DATA_SYNTHESIS_APPLIED',
            report,
            deviceId: this.deviceId,
            timestamp: Date.now()
          });
        } catch {}
      }

      // Dispatch custom DOM event asynchronously to prevent React setState-in-render violations
      if (typeof window !== 'undefined') {
        const dispatchEvent = () => {
          window.dispatchEvent(new CustomEvent('hss:cloud-sync-synthesized', { detail: { report } }));
        };
        if (typeof queueMicrotask === 'function') {
          queueMicrotask(dispatchEvent);
        } else {
          setTimeout(dispatchEvent, 0);
        }
      }

      const currentBundle = this.gatherAllLocalData();
      this.lastSavedPayloadHash = this.computeBundleHash(currentBundle);
      return report;
    } finally {
      setTimeout(() => {
        setStorageMutationSilenced(false);
        this.isApplyingRemoteUpdate = false;
      }, 100);
    }
  }

  private computeBundleHash(bundle: UserCloudBundle): string {
    return JSON.stringify({
      classes: bundle.classesCatalog,
      teacher: bundle.teacherInfo,
      school: bundle.schoolProfile,
      classData: bundle.classData,
      reminders: bundle.reminders,
      timetables: bundle.timetables
    });
  }

  private sanitizeForFirestore<T extends Record<string, any>>(obj: T | null | undefined): T | null {
    if (!obj || typeof obj !== 'object') return null;
    const copy: any = { ...obj };
    delete copy.password;
    delete copy.adminPassword;
    return copy;
  }

  public async pushToCloud(user?: FirebaseUser | null): Promise<boolean> {
    const currentUser = user || auth?.currentUser;
    let syncEmail = this.getActiveSyncEmail();

    if (!syncEmail) {
      const authSession = StorageService.getAuthSession();
      const candidate =
        authSession?.currentTeacher?.gmail ||
        authSession?.currentTeacher?.email ||
        authSession?.currentAdmin?.email ||
        currentUser?.email;
      if (candidate && candidate.includes('@')) {
        syncEmail = candidate.trim().toLowerCase();
        this.setActiveSyncEmail(syncEmail);
      }
    }

    if (!currentUser && !syncEmail) {
      this.setSaveState('offline');
      this.notify('offline');
      return false;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      try {
        localStorage.setItem('hss_pending_offline_sync', 'true');
      } catch {}
      this.setSaveState('offline');
      this.notify('offline');
      this.scheduleOfflineRetry();
      return false;
    }

    try {
      const rawBundle = this.gatherAllLocalData();
      // Strip any legacy plaintext password properties before persisting anywhere in cloud
      const bundle: UserCloudBundle = {
        ...rawBundle,
        teacherAccounts: (rawBundle.teacherAccounts || []).map(t => this.sanitizeForFirestore(t) as TeacherAccount),
        schoolAdmins: (rawBundle.schoolAdmins || []).map(a => this.sanitizeForFirestore(a) as SchoolAdminAccount)
      };
      const currentHash = this.computeBundleHash(bundle);

      if (currentHash === this.lastSavedPayloadHash && this.currentStatus === 'synced') {
        return true;
      }

      this.setSaveState('saving');
      this.notify('syncing');

      const promises: Promise<any>[] = [];
      const rawSession = StorageService.getAuthSession();
      const rawSessionSchoolCode =
        rawSession.currentTeacher?.schoolCode ||
        rawSession.currentAdmin?.schoolCode ||
        bundle.schoolProfile.schoolCode;
      const schoolCode = this.sanitizeSchoolCode(bundle.schoolProfile.schoolCode || rawSessionSchoolCode);
      const activeSession = rawSession;
      const sanitizedSessionTeacher = this.sanitizeForFirestore(activeSession.currentTeacher);
      const sanitizedSessionAdmin = this.sanitizeForFirestore(activeSession.currentAdmin);
      const nowIso = new Date().toISOString();

      // 1. Write /users/{uid} FIRST and await it so Firestore security rules checking /users/$(uid).data.schoolCode succeed!
      if (currentUser) {
        if (firestore) {
          const userDocRef = fsDoc(firestore, 'users', currentUser.uid);
          const resolvedRole = activeSession.role === 'admin' ? 'admin' : 'teacher';
          const userPayload: Record<string, any> = {
            userId: currentUser.uid,
            uid: currentUser.uid,
            email: currentUser.email || syncEmail || '',
            gmail: currentUser.email || syncEmail || '',
            displayName: (currentUser.displayName || bundle.teacherInfo.teacherName || 'Teacher').slice(0, 150),
            lastSyncedAt: bundle.lastSyncedAt,
            deviceId: this.deviceId,
            schoolCode,
            role: resolvedRole,
            updatedAt: nowIso,
            appData: bundle
          };
          if (sanitizedSessionTeacher) userPayload.teacherAccount = sanitizedSessionTeacher;
          if (sanitizedSessionAdmin) userPayload.adminAccount = sanitizedSessionAdmin;

          try {
            const existingUserSnap = await fsGetDoc(userDocRef).catch(() => null);
            if (existingUserSnap && existingUserSnap.exists()) {
              const existingRole = existingUserSnap.data()?.role;
              if (existingRole && existingRole !== resolvedRole && resolvedRole !== 'admin') {
                // Never downgrade an existing admin user doc during non-admin sync
                userPayload.role = existingRole;
              }
            }
            await fsSetDoc(userDocRef, userPayload, { merge: true });
          } catch (fsErr) {
            console.error('[CloudSync] Firestore users/{uid} write failed:', fsErr);
            throw fsErr;
          }
        }

        if (database) {
          const userRefPath = ref(database, 'users/' + currentUser.uid);
          promises.push(
            set(userRefPath, {
              userId: currentUser.uid,
              email: currentUser.email || syncEmail || '',
              displayName: currentUser.displayName || bundle.teacherInfo.teacherName || 'Teacher',
              photoURL: currentUser.photoURL || '',
              lastSyncedAt: bundle.lastSyncedAt,
              deviceId: this.deviceId,
              appData: bundle
            }).catch(e => console.warn('RTDB push users note:', e))
          );
        }
      }

      // 2. Auto-sync current teacher profile ONLY for non-admin teacher sessions whose profile matches currentUser
      const currentTeacherAcc =
        activeSession.role !== 'admin'
          ? (sanitizedSessionTeacher ||
              bundle.teacherAccounts?.find(
                t =>
                  t.uid === currentUser?.uid ||
                  t.id === currentUser?.uid ||
                  (syncEmail && (t.email || t.gmail || '').toLowerCase() === syncEmail.toLowerCase())
              ) ||
              null)
          : null;
      if (currentUser && schoolCode && currentTeacherAcc && currentTeacherAcc.name) {
        const cleanTId = currentUser.uid;
        const cleanTEmail = (currentTeacherAcc.email || currentTeacherAcc.gmail || currentUser.email || '').trim().toLowerCase();
        const rawPhotoUrl = String(currentTeacherAcc.photoUrl || '');
        const safePhotoUrl = !rawPhotoUrl.startsWith('data:') && rawPhotoUrl.length <= 1450 ? rawPhotoUrl : '';
        const teacherProfileRecord: Record<string, any> = {
          id: cleanTId,
          uid: cleanTId,
          name: (currentTeacherAcc.name || bundle.teacherInfo.teacherName || 'Teacher').slice(0, 150),
          email: cleanTEmail.slice(0, 200),
          gmail: cleanTEmail.slice(0, 200),
          dob: String(currentTeacherAcc.dob || '').slice(0, 32),
          dateOfBirth: String(currentTeacherAcc.dob || '').slice(0, 32),
          phone: String(currentTeacherAcc.phone || bundle.teacherInfo.phone || '').slice(0, 40),
          schoolName: String(bundle.schoolProfile.schoolName || currentTeacherAcc.schoolName || "St. Sebastian's Higher Secondary School").slice(0, 200),
          schoolCode,
          academicYear: String(currentTeacherAcc.academicYear || bundle.teacherInfo.academicYear || '2026-2027').slice(0, 32),
          subject: String(currentTeacherAcc.subject || currentTeacherAcc.primarySubject || bundle.teacherInfo.designation || 'General').slice(0, 100),
          primarySubject: String(currentTeacherAcc.primarySubject || currentTeacherAcc.subject || 'General').slice(0, 100),
          standard: String(currentTeacherAcc.standard || bundle.classInfo.standard || '').slice(0, 80),
          stream: String(currentTeacherAcc.stream || bundle.classInfo.stream || '').slice(0, 80),
          section: String(currentTeacherAcc.section || bundle.classInfo.section || '').slice(0, 20),
          assignedClass: String(currentTeacherAcc.assignedClass || bundle.classInfo.className || '').slice(0, 150),
          designation: String(currentTeacherAcc.designation || bundle.teacherInfo.designation || 'Class Teacher').slice(0, 120),
          photoUrl: safePhotoUrl,
          avatar: String(currentTeacherAcc.avatar || '👨‍🏫').slice(0, 40),
          status: 'active',
          updatedAt: nowIso,
          lastActiveAt: nowIso,
          recentActivity: String(currentTeacherAcc.recentActivity || `Active in ${bundle.classInfo.className || 'Classroom'}`).slice(0, 500)
        };

        if (database) {
          promises.push(set(ref(database, `schools/${schoolCode}/teachers/${cleanTId}`), teacherProfileRecord).catch(() => {}));
          promises.push(set(ref(database, `teachers/${cleanTId}`), teacherProfileRecord).catch(() => {}));
        }
        if (firestore) {
          const existingTeacherSnap = await fsGetDoc(fsDoc(firestore, `schools/${schoolCode}/teachers/${cleanTId}`)).catch(() => null);
          const teacherWritePayload = existingTeacherSnap && existingTeacherSnap.exists()
            ? teacherProfileRecord
            : { ...teacherProfileRecord, createdAt: currentTeacherAcc.createdAt || nowIso };

          promises.push(
            fsSetDoc(fsDoc(firestore, `schools/${schoolCode}`), {
              schoolCode,
              schoolName: teacherProfileRecord.schoolName,
              updatedAt: nowIso
            }, { merge: true }).catch(e => console.warn('Firestore schools root sync note:', e))
          );
          promises.push(fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/teachers/${cleanTId}`), teacherWritePayload, { merge: true }).catch(e => console.warn('Firestore school teacher sync note:', e)));
          promises.push(fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/teacherSignups/${cleanTId}`), teacherWritePayload, { merge: true }).catch(e => console.warn('Firestore school signup sync note:', e)));
          promises.push(fsSetDoc(fsDoc(firestore, `teachers/${cleanTId}`), teacherWritePayload, { merge: true }).catch(e => console.warn('Firestore root teacher sync note:', e)));
          promises.push(fsSetDoc(fsDoc(firestore, `teacherSignups/${cleanTId}`), teacherWritePayload, { merge: true }).catch(e => console.warn('Firestore root signup sync note:', e)));
          if (cleanTEmail) {
            const emailCredKey = this.sanitizeEmailKey(cleanTEmail);
            promises.push(fsSetDoc(fsDoc(firestore, `teacher_credentials/${emailCredKey}`), {
              gmail: cleanTEmail,
              email: cleanTEmail,
              dob: teacherProfileRecord.dob || '',
              dateOfBirth: teacherProfileRecord.dob || '',
              schoolCode,
              schoolName: teacherProfileRecord.schoolName,
              teacherId: cleanTId,
              uid: cleanTId,
              name: teacherProfileRecord.name,
              phone: teacherProfileRecord.phone,
              subject: teacherProfileRecord.subject,
              assignedClass: teacherProfileRecord.assignedClass,
              role: 'teacher',
              updatedAt: nowIso
            }, { merge: true }).catch(e => console.warn('Firestore teacher_credentials sync note:', e)));
          }
        }
      }

      // 3. Class synchronization to school roster (classes, students, attendance, exams, marks)
      if (currentUser && schoolCode && bundle.classesCatalog && bundle.classesCatalog.length > 0) {
        for (const cls of bundle.classesCatalog) {
          const scoped = bundle.classData?.[cls.id];
          const clsStudents = scoped?.students || [];
          const clsAttendance = scoped?.attendance || [];
          const clsExams = scoped?.exams || [];
          const clsMarksMap = scoped?.examMarksMap || {};

          const fsClassDoc: Record<string, any> = {
            id: cls.id,
            className: cls.className || 'Class',
            standard: cls.standard || '',
            stream: cls.stream || '',
            section: cls.section || '',
            academicYear: cls.academicYear || '',
            classStrength: clsStudents.length,
            teacherId: cls.teacherId || currentUser.uid,
            teacherUid: cls.teacherUid || cls.teacherId || currentUser.uid,
            teacherName: cls.teacherName || bundle.teacherInfo.teacherName || 'Teacher',
            schoolCode,
            isTeacherCreated: Boolean(cls.isTeacherCreated ?? true),
            createdByTeacherId: cls.createdByTeacherId || cls.teacherId || currentUser.uid,
            createdByTeacherEmail: cls.createdByTeacherEmail || (syncEmail || '').trim().toLowerCase(),
            attendanceCount: clsAttendance.length,
            examCount: clsExams.length,
            createdAt: cls.createdAt || nowIso,
            updatedAt: nowIso
          };

          if (database) {
            const clsRef = ref(database, `schools/${schoolCode}/classes/${cls.id}`);
            promises.push(set(clsRef, { ...fsClassDoc, students: clsStudents }).catch(() => {}));
          }

          if (firestore) {
            const classDocRef = fsDoc(firestore, 'schools', schoolCode, 'classes', cls.id);
            promises.push(fsSetDoc(classDocRef, fsClassDoc, { merge: true }).catch(e => console.warn('Firestore class sync note:', e)));

            for (const s of clsStudents) {
              if (s && s.id) {
                const studentPayload = this.sanitizeStudentPayload(s, cls.id, schoolCode, currentUser.uid);
                promises.push(
                  fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/classes/${cls.id}/students/${s.id}`), studentPayload, { merge: true }).catch(e => console.warn('Firestore class student sync note:', e)),
                  fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/students/${s.id}`), studentPayload, { merge: true }).catch(e => console.warn('Firestore school student sync note:', e))
                );
              }
            }

            for (const att of clsAttendance) {
              if (att && att.id) {
                const attPayload = this.sanitizeAttendancePayload(att, cls.id, schoolCode, currentUser.uid);
                promises.push(
                  fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/classes/${cls.id}/attendance/${att.id}`), attPayload, { merge: true }).catch(e => console.warn('Firestore attendance sync note:', e))
                );
              }
            }

            for (const ex of clsExams) {
              if (ex && ex.id) {
                const examPayload = this.sanitizeExamPayload(ex, cls.id, schoolCode, currentUser.uid);
                promises.push(
                  fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/classes/${cls.id}/exams/${ex.id}`), examPayload, { merge: true }).catch(e => console.warn('Firestore exam sync note:', e))
                );
              }
            }

            for (const [exId, markRec] of Object.entries(clsMarksMap)) {
              if (exId && markRec) {
                const marksPayload = {
                  examId: exId,
                  marks: markRec.marks || {},
                  updatedAt: markRec.updatedAt || nowIso,
                  classId: cls.id,
                  teacherId: currentUser.uid,
                  teacherUid: currentUser.uid,
                  schoolCode
                };
                promises.push(
                  fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/classes/${cls.id}/examMarks/${exId}`), marksPayload, { merge: true }).catch(e => console.warn('Firestore examMarks sync note:', e))
                );
              }
            }
          }
        }
      }

      // 4. Sync school root, school profile, timetables, timetable preferences, and reminders to Firestore
      if (currentUser && schoolCode && firestore) {
        const sp = bundle.schoolProfile;
        promises.push(
          fsSetDoc(fsDoc(firestore, `schools/${schoolCode}`), {
            schoolCode,
            schoolName: sp.schoolName || "St. Sebastian's Higher Secondary School",
            updatedAt: nowIso
          }, { merge: true }).catch(e => console.warn('Firestore schools root sync note:', e))
        );
        const cleanSchoolProfile: Record<string, any> = {
          schoolName: sp.schoolName || "St. Sebastian's Higher Secondary School",
          schoolCode,
          schoolAddress: sp.schoolAddress || '',
          schoolPhone: sp.schoolPhone || '',
          schoolEmail: sp.schoolEmail || '',
          principalName: sp.principalName || '',
          principalPhone: sp.principalPhone || ''
        };
        promises.push(fsSetDoc(fsDoc(firestore, 'schools', schoolCode, 'schoolProfile', 'info'), cleanSchoolProfile, { merge: true }).catch(e => console.warn('Firestore schoolProfile sync note:', e)));

        if (bundle.timetables && bundle.timetables.length > 0) {
          for (const slot of bundle.timetables) {
            if (slot && slot.id) {
              promises.push(
                fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/timetables/${slot.id}`), this.sanitizeTimetablePayload(slot, schoolCode, currentUser.uid), { merge: true }).catch(e => console.warn('Firestore timetable slot sync note:', e))
              );
            }
          }
        }

        if (bundle.timetablePrefs && Object.keys(bundle.timetablePrefs).length > 0) {
          promises.push(
            fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/timetablePrefs/config`), {
              ownerUid: currentUser.uid,
              schoolCode,
              teacherId: currentUser.uid,
              includeSaturday: Boolean(bundle.timetablePrefs.includeSaturday),
              periodTimings: Array.isArray(bundle.timetablePrefs.periodTimings) ? bundle.timetablePrefs.periodTimings : [],
              prefs: bundle.timetablePrefs,
              updatedAt: nowIso
            }, { merge: true }).catch(e => console.warn('Firestore timetablePrefs sync note:', e))
          );
        }

        if (bundle.reminders && bundle.reminders.length > 0) {
          for (const rem of bundle.reminders) {
            if (rem && rem.id) {
              promises.push(
                fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/reminders/${rem.id}`), this.sanitizeReminderPayload(rem, schoolCode, currentUser.uid), { merge: true }).catch(e => console.warn('Firestore reminder sync note:', e))
              );
            }
          }
        }
      }

      // 5. Save all changes under the same Gmail bundle keyed with ownerUid (no duplicate users/{emailKey} write!)
      if (currentUser && syncEmail) {
        const emailKey = this.sanitizeEmailKey(syncEmail);

        if (database) {
          const emailRefPath = ref(database, 'email_accounts/' + emailKey);
          promises.push(
            set(emailRefPath, {
              ownerUid: currentUser.uid,
              email: syncEmail,
              schoolCode,
              role: activeSession.role || 'teacher',
              teacherAccount: sanitizedSessionTeacher || (bundle.teacherAccounts.find(t => t.email?.toLowerCase() === syncEmail.toLowerCase()) || null),
              adminAccount: sanitizedSessionAdmin || (bundle.schoolAdmins?.find(a => a.email?.toLowerCase() === syncEmail.toLowerCase()) || null),
              lastSyncedAt: bundle.lastSyncedAt,
              deviceId: this.deviceId,
              updatedAt: nowIso,
              appData: bundle
            }).catch(e => console.warn('RTDB email_accounts note:', e))
          );
        }

        if (firestore) {
          const emailDocRef = fsDoc(firestore, 'email_accounts', emailKey);
          const emailPayload: Record<string, any> = {
            ownerUid: currentUser.uid,
            email: syncEmail,
            schoolCode,
            role: activeSession.role || 'teacher',
            lastSyncedAt: bundle.lastSyncedAt,
            deviceId: this.deviceId,
            updatedAt: nowIso,
            appData: bundle
          };
          const matchedTeacher = sanitizedSessionTeacher || bundle.teacherAccounts.find(t => t.email?.toLowerCase() === syncEmail.toLowerCase()) || null;
          const matchedAdmin = sanitizedSessionAdmin || bundle.schoolAdmins?.find(a => a.email?.toLowerCase() === syncEmail.toLowerCase()) || null;
          if (matchedTeacher) emailPayload.teacherAccount = matchedTeacher;
          if (matchedAdmin) emailPayload.adminAccount = matchedAdmin;

          promises.push(
            fsSetDoc(emailDocRef, emailPayload, { merge: true }).catch(e => console.warn('Firestore email_accounts note:', e))
          );

          // Keep /gmail/{emailKey} and /schools/{schoolCode}/gmail/{emailKey} continuously updated
          const authProvider = currentUser.providerData?.some(p => p.providerId === 'google.com')
            ? 'google'
            : 'email_password';
          const dirPayload: Record<string, any> = {
            uid: currentUser.uid,
            teacherId: currentUser.uid,
            gmail: syncEmail,
            email: syncEmail,
            role: activeSession.role === 'admin' ? 'admin' : 'teacher',
            name: (matchedTeacher?.name || matchedAdmin?.adminName || bundle.teacherInfo.teacherName || currentUser.displayName || 'Teacher').slice(0, 150),
            schoolCode,
            schoolName: String(bundle.schoolProfile.schoolName || matchedTeacher?.schoolName || matchedAdmin?.schoolName || '').slice(0, 200),
            loginMethod: authProvider === 'google' ? 'google' : 'email',
            authProvider,
            passwordProtected: true,
            credentialStatus: authProvider === 'google' ? 'Google OAuth Protected' : 'Firebase Auth Protected',
            lastEntryAt: nowIso,
            updatedAt: nowIso
          };
          const dobVal = matchedTeacher?.dob || matchedAdmin?.dob || '';
          if (dobVal) {
            dirPayload.dob = String(dobVal).slice(0, 32);
            dirPayload.dateOfBirth = String(dobVal).slice(0, 32);
          }
          if (matchedTeacher?.phone || bundle.teacherInfo.phone) {
            dirPayload.phone = String(matchedTeacher?.phone || bundle.teacherInfo.phone).slice(0, 40);
          }
          if (matchedTeacher?.subject || matchedTeacher?.primarySubject) {
            dirPayload.subject = String(matchedTeacher?.subject || matchedTeacher?.primarySubject).slice(0, 100);
          }
          if (matchedTeacher?.assignedClass || bundle.classInfo.className) {
            dirPayload.assignedClass = String(matchedTeacher?.assignedClass || bundle.classInfo.className).slice(0, 150);
          }
          if (matchedTeacher?.designation || matchedAdmin?.designation || bundle.teacherInfo.designation) {
            dirPayload.designation = String(matchedTeacher?.designation || matchedAdmin?.designation || bundle.teacherInfo.designation).slice(0, 100);
          }
          promises.push(
            fsSetDoc(fsDoc(firestore, 'gmail', emailKey), dirPayload, { merge: true }).catch(() => {}),
            fsSetDoc(fsDoc(firestore, `schools/${schoolCode}/gmail/${emailKey}`), dirPayload, { merge: true }).catch(() => {})
          );
        }
      }

      // Update device presence heartbeat in RTDB
      const devicePresencePayload = {
        deviceId: this.deviceId,
        name: this.getDeviceCustomName(),
        platform: this.detectDevicePlatform(),
        lastActiveAt: nowIso,
        appVersion: '2.5.0',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : ''
      };

      if (database) {
        if (currentUser) {
          promises.push(
            set(ref(database, 'users/' + currentUser.uid + '/devices/' + this.deviceId), devicePresencePayload).catch(() => {})
          );
        }
        if (syncEmail) {
          const emailKey = this.sanitizeEmailKey(syncEmail);
          promises.push(
            set(ref(database, 'email_accounts/' + emailKey + '/devices/' + this.deviceId), devicePresencePayload).catch(() => {})
          );
        }
      }

      const timeoutPromise = new Promise(res => setTimeout(res, 2500));
      await Promise.race([Promise.allSettled(promises), timeoutPromise]);

      if (this.broadcastChannel) {
        try {
          this.broadcastChannel.postMessage({
            type: 'DATA_PUSHED',
            deviceId: this.deviceId,
            timestamp: Date.now()
          });
        } catch {}
      }

      try {
        localStorage.removeItem('hss_pending_offline_sync');
      } catch {}
      this.retryAttempt = 0;
      this.lastSavedPayloadHash = currentHash;
      this.lastSyncedAt = bundle.lastSyncedAt;
      localStorage.setItem('hss_last_cloud_sync', bundle.lastSyncedAt);
      this.setSaveState('saved');
      this.notify('synced');
      return true;
    } catch (err: any) {
      console.error('Sync status error:', err);
      try {
        localStorage.setItem('hss_pending_offline_sync', 'true');
      } catch {}
      this.setSaveState('error');
      this.scheduleOfflineRetry();
      this.notify('error', err);
      return false;
    }
  }

  private sanitizeStudentPayload(s: Student, classId: string, schoolCode: string, teacherUid?: string): Record<string, any> {
    const out: Record<string, any> = {
      id: s.id,
      rollNo: Number(s.rollNo) || 0,
      name: s.name || 'Student',
      schoolCode,
      classId: s.classId || classId
    };
    if (s.admissionNo !== undefined) out.admissionNo = String(s.admissionNo);
    if (s.gender && ['male', 'female', 'other'].includes(s.gender)) out.gender = s.gender;
    if (s.teacherId || teacherUid) out.teacherId = s.teacherId || teacherUid;
    if (teacherUid) out.teacherUid = teacherUid;
    if (s.phone) out.phone = s.phone;
    if (s.parentName) out.parentName = s.parentName;
    if (s.parentPhone) out.parentPhone = s.parentPhone;
    if (s.guardianPhone) out.guardianPhone = s.guardianPhone;
    if (s.division) out.division = s.division;
    if (s.dob) out.dob = s.dob;
    if (s.address) out.address = s.address;
    if (s.bloodGroup) out.bloodGroup = s.bloodGroup;
    if (s.notes) out.notes = s.notes;
    if (s.photoUrl && s.photoUrl.length <= 1500) out.photoUrl = s.photoUrl;
    if (s.avatar) out.avatar = s.avatar;
    if (s.createdAt) out.createdAt = s.createdAt;
    return out;
  }

  private sanitizeAttendancePayload(att: AttendanceRecord, classId: string, schoolCode: string, teacherUid?: string): Record<string, any> {
    const out: Record<string, any> = {
      id: att.id,
      date: att.date,
      classId: att.classId || classId,
      schoolCode,
      presentStudentIds: Array.isArray(att.presentStudentIds) ? att.presentStudentIds.slice(0, 500) : [],
      absentStudentIds: Array.isArray(att.absentStudentIds) ? att.absentStudentIds.slice(0, 500) : [],
      onDutyStudentIds: Array.isArray(att.onDutyStudentIds) ? att.onDutyStudentIds.slice(0, 500) : [],
      savedAt: att.savedAt || new Date().toISOString()
    };
    if (att.notes) out.notes = att.notes.slice(0, 1000);
    if (teacherUid) {
      out.teacherId = teacherUid;
      out.teacherUid = teacherUid;
    }
    return out;
  }

  private sanitizeExamPayload(ex: Exam, classId: string, schoolCode: string, teacherUid?: string): Record<string, any> {
    const out: Record<string, any> = {
      id: ex.id,
      name: ex.name,
      classId: ex.classId || classId,
      schoolCode,
      subjects: Array.isArray(ex.subjects) ? ex.subjects.slice(0, 50) : [],
      createdAt: ex.createdAt || new Date().toISOString()
    };
    if (ex.type) out.type = ex.type;
    if (ex.date) out.date = ex.date;
    if (ex.academicYear) out.academicYear = ex.academicYear;
    if (teacherUid) {
      out.teacherId = teacherUid;
      out.teacherUid = teacherUid;
    }
    return out;
  }

  private sanitizeTimetablePayload(slot: TimetableSlot, schoolCode: string, teacherUid?: string): Record<string, any> {
    const out: Record<string, any> = {
      id: slot.id,
      day: slot.day || 'Monday',
      periodNumber: Math.max(1, Math.min(20, Number(slot.periodNumber) || 1)),
      subject: slot.subject || 'Subject',
      schoolCode
    };
    if (slot.startTime) out.startTime = slot.startTime;
    if (slot.endTime) out.endTime = slot.endTime;
    if (slot.subjectCode) out.subjectCode = slot.subjectCode;
    if (slot.className) out.className = slot.className;
    if (slot.classId) out.classId = slot.classId;
    if (slot.teacherId || teacherUid) out.teacherId = slot.teacherId || teacherUid;
    if (slot.teacherName) out.teacherName = slot.teacherName;
    if (slot.roomNumber) out.roomNumber = slot.roomNumber;
    if (slot.type) out.type = slot.type;
    if (slot.notes) out.notes = slot.notes;
    if (slot.createdAt) out.createdAt = slot.createdAt;
    if (slot.updatedAt) out.updatedAt = slot.updatedAt;
    return out;
  }

  private sanitizeReminderPayload(rem: Reminder, schoolCode: string, ownerUid?: string): Record<string, any> {
    const out: Record<string, any> = {
      id: rem.id,
      title: rem.title,
      date: rem.date,
      schoolCode,
      isCompleted: Boolean(rem.isCompleted)
    };
    if (rem.description) out.description = rem.description.slice(0, 1000);
    if (rem.time) out.time = rem.time;
    if (rem.repeat && ['none', 'daily', 'weekly', 'monthly'].includes(rem.repeat)) out.repeat = rem.repeat;
    if (rem.category && ['attendance', 'exam', 'marks', 'meeting', 'general'].includes(rem.category)) out.category = rem.category;
    if (rem.priority && ['low', 'medium', 'high'].includes(rem.priority)) out.priority = rem.priority;
    if (ownerUid) out.ownerUid = ownerUid;
    if (rem.createdAt) out.createdAt = rem.createdAt;
    return out;
  }


  public async getConnectedDevices(): Promise<ConnectedDevice[]> {
    const devicesMap = new Map<string, ConnectedDevice>();

    // Current device always present
    const currentDevice: ConnectedDevice = {
      deviceId: this.deviceId,
      name: this.getDeviceCustomName(),
      platform: this.detectDevicePlatform(),
      isCurrentDevice: true,
      lastActiveAt: new Date().toISOString(),
      appVersion: '2.5.0',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : ''
    };
    devicesMap.set(this.deviceId, currentDevice);

    const currentUser = auth?.currentUser;
    const syncEmail = this.getActiveSyncEmail();

    if (database) {
      const pathsToQuery: string[] = [];
      if (currentUser) pathsToQuery.push('users/' + currentUser.uid + '/devices');
      if (syncEmail) pathsToQuery.push('email_accounts/' + this.sanitizeEmailKey(syncEmail) + '/devices');

      for (const p of pathsToQuery) {
        try {
          const snap = await get(ref(database, p));
          if (snap.exists()) {
            const data = snap.val();
            if (data && typeof data === 'object') {
              Object.entries(data).forEach(([devId, devInfo]: [string, any]) => {
                if (devId && devInfo) {
                  const isCurrent = devId === this.deviceId;
                  const lastActive = devInfo.lastActiveAt || devInfo.updatedAt || new Date().toISOString();
                  const ageMs = Date.now() - new Date(lastActive).getTime();
                  if (ageMs < 48 * 3600 * 1000) {
                    devicesMap.set(devId, {
                      deviceId: devId,
                      name: isCurrent ? currentDevice.name : (devInfo.name || 'Connected Device'),
                      platform: devInfo.platform || 'Web Browser',
                      isCurrentDevice: isCurrent,
                      lastActiveAt: lastActive,
                      appVersion: devInfo.appVersion || '2.5.0',
                      userAgent: devInfo.userAgent || ''
                    });
                  }
                }
              });
            }
          }
        } catch (e) {
          console.warn('Connected devices query note:', e);
        }
      }
    }

    return Array.from(devicesMap.values()).sort((a, b) => (b.isCurrentDevice ? 1 : 0) - (a.isCurrentDevice ? 1 : 0));
  }

  public async forceDeepSynthesis(): Promise<{ success: boolean; report: SynthesisReport | null }> {
    this.notify('syncing');
    try {
      const currentUser = auth?.currentUser;
      const syncEmail = this.getActiveSyncEmail();
      let remoteBundle: Partial<UserCloudBundle> | null = null;
      let sourceDev = '';

      if (currentUser) {
        const res = await this.fetchFromCloud(currentUser);
        if (res.found && res.data) {
          remoteBundle = res.data;
          sourceDev = res.data.deviceId || '';
        }
      }
      if (!remoteBundle && syncEmail) {
        const res = await this.fetchAccountByEmail(syncEmail);
        if (res.found && res.appData) {
          remoteBundle = res.appData;
          sourceDev = res.appData.deviceId || '';
        }
      }

      let report: SynthesisReport | null = null;
      if (remoteBundle) {
        report = this.applyCloudBundle(remoteBundle, sourceDev);
      } else {
        const local = this.gatherAllLocalData();
        const synthRes = this.synthesizeDataBundle(local, {}, this.deviceId);
        report = synthRes.report;
        this.lastSynthesisReport = report;
      }

      // Push synthesized bundle to cloud immediately
      await this.pushToCloud();
      this.notify('synced');
      return { success: true, report };
    } catch (err) {
      console.warn('forceDeepSynthesis note:', err);
      this.notify('error', err);
      return { success: false, report: null };
    }
  }

  public async fetchAccountByUid(
    uid: string
  ): Promise<{
    found: boolean;
    role?: 'teacher' | 'admin';
    teacherAccount?: TeacherAccount;
    adminAccount?: SchoolAdminAccount;
    appData?: UserCloudBundle;
    lastSyncedAt?: string;
  }> {
    if (!uid) return { found: false };

    if (firestore) {
      try {
        const userDocRef = fsDoc(firestore, 'users', uid);
        const snap = await fsGetDoc(userDocRef);
        if (snap.exists()) {
          const data = snap.data();
          if (data) {
            return {
              found: true,
              role: data.role || 'teacher',
              teacherAccount: data.teacherAccount || {
                id: uid,
                name: data.displayName || data.name || 'Teacher',
                email: data.email || '',
                phone: data.phone || '',
                schoolName: data.schoolName || '',
                schoolCode: data.schoolCode || '',
                subject: data.subject || '',
                designation: data.designation || 'Class Teacher',
                createdAt: data.createdAt || new Date().toISOString()
              },
              adminAccount: data.adminAccount,
              appData: data.appData,
              lastSyncedAt: data.lastSyncedAt
            };
          }
        }
      } catch (err) {
        console.warn('Firestore fetchAccountByUid error:', err);
      }
    }

    if (database) {
      try {
        const userRefPath = ref(database, 'users/' + uid);
        const snap = await get(userRefPath);
        if (snap.exists()) {
          const data = snap.val();
          if (data) {
            return {
              found: true,
              role: data.role || 'teacher',
              teacherAccount: data.teacherAccount || data.appData?.teacherAccounts?.find((t: any) => t.id === uid),
              adminAccount: data.adminAccount,
              appData: data.appData,
              lastSyncedAt: data.lastSyncedAt
            };
          }
        }
      } catch (err) {
        console.warn('RTDB fetchAccountByUid error:', err);
      }
    }

    return { found: false };
  }

  public async fetchAccountByEmail(
    email: string,
    schoolCode?: string
  ): Promise<{
    found: boolean;
    role?: 'teacher' | 'admin';
    teacherAccount?: TeacherAccount;
    adminAccount?: SchoolAdminAccount;
    appData?: UserCloudBundle;
    lastSyncedAt?: string;
  }> {
    if (!email || !email.trim()) return { found: false };
    const cleanEmail = email.trim().toLowerCase();

    if (firestore) {
      try {
        const emailKey = this.sanitizeEmailKey(cleanEmail);
        const emailDocRef = fsDoc(firestore, 'email_accounts', emailKey);
        const snap = await fsGetDoc(emailDocRef);
        if (snap.exists()) {
          const data = snap.data();
          if (data && (data.appData || data.teacherAccount || data.adminAccount)) {
            return {
              found: true,
              role: data.role || 'teacher',
              teacherAccount: data.teacherAccount,
              adminAccount: data.adminAccount,
              appData: data.appData as UserCloudBundle | undefined,
              lastSyncedAt: data.lastSyncedAt || data.updatedAt
            };
          }
        }

        const usersCol = fsCollection(firestore, 'users');
        const q = fsQuery(usersCol, fsWhere('email', '==', cleanEmail));
        const querySnap = await fsGetDocs(q);
        if (!querySnap.empty && querySnap.docs.length > 0) {
          const docData = querySnap.docs[0].data();
          if (docData) {
            return {
              found: true,
              role: docData.role || 'teacher',
              teacherAccount: docData.teacherAccount || {
                id: querySnap.docs[0].id,
                name: docData.displayName || docData.name || 'Teacher',
                email: cleanEmail,
                phone: docData.phone || '',
                schoolName: docData.schoolName || '',
                schoolCode: docData.schoolCode || '',
                subject: docData.subject || '',
                designation: docData.designation || 'Class Teacher',
                createdAt: docData.createdAt || new Date().toISOString()
              },
              adminAccount: docData.adminAccount,
              appData: docData.appData,
              lastSyncedAt: docData.lastSyncedAt
            };
          }
        }
      } catch (e) {
        console.warn('Firestore fetchAccountByEmail error:', e);
      }
    }

    if (!database) {
      this.notify('synced');
      return { found: false };
    }

    try {
      this.notify('syncing');
      const emailKey = this.sanitizeEmailKey(cleanEmail);
      const emailRefPath = ref(database, 'email_accounts/' + emailKey);
      const snap = await get(emailRefPath);

      if (snap.exists()) {
        const data = snap.val();
        if (data) {
          const appData = data.appData as UserCloudBundle | undefined;
          this.notify('synced');
          return {
            found: true,
            role: data.role || 'teacher',
            teacherAccount: data.teacherAccount,
            adminAccount: data.adminAccount,
            appData,
            lastSyncedAt: data.lastSyncedAt
          };
        }
      }
      this.notify('synced');
      return { found: false };
    } catch (err) {
      console.warn('Error fetching account by email from RTDB:', err);
      this.notify('error', err);
      return { found: false };
    }
  }

  public async saveAccountToCloud(
    email: string,
    payload: {
      role: 'teacher' | 'admin';
      teacherAccount?: TeacherAccount;
      adminAccount?: SchoolAdminAccount;
      schoolCode?: string;
      appData?: UserCloudBundle;
    }
  ): Promise<boolean> {
    if (!email || !email.trim()) return false;
    const cleanEmail = email.trim().toLowerCase();

    try {
      this.notify('syncing');
      const emailKey = this.sanitizeEmailKey(cleanEmail);
      const rawBundle = payload.appData || this.gatherAllLocalData();
      const bundle: UserCloudBundle = {
        ...rawBundle,
        teacherAccounts: (rawBundle.teacherAccounts || []).map(t => this.sanitizeForFirestore(t) as TeacherAccount),
        schoolAdmins: (rawBundle.schoolAdmins || []).map(a => this.sanitizeForFirestore(a) as SchoolAdminAccount)
      };
      const cleanTeacher = this.sanitizeForFirestore(payload.teacherAccount);
      const cleanAdmin = this.sanitizeForFirestore(payload.adminAccount);
      const ownerUid =
        auth?.currentUser?.uid ||
        cleanTeacher?.uid ||
        cleanTeacher?.id ||
        cleanAdmin?.id ||
        '';
      const now = new Date().toISOString();

      if (database) {
        const emailRefPath = ref(database, 'email_accounts/' + emailKey);
        await set(emailRefPath, {
          ownerUid,
          email: cleanEmail,
          schoolCode: payload.schoolCode || bundle.schoolProfile.schoolCode || '',
          role: payload.role,
          teacherAccount: cleanTeacher || null,
          adminAccount: cleanAdmin || null,
          lastSyncedAt: now,
          updatedAt: now,
          appData: bundle
        }).catch(() => {});
      }

      if (firestore && ownerUid) {
        try {
          const emailDocRef = fsDoc(firestore, 'email_accounts', emailKey);
          const fsEmailPayload: Record<string, any> = {
            ownerUid,
            email: cleanEmail,
            schoolCode: payload.schoolCode || bundle.schoolProfile.schoolCode || '',
            role: payload.role,
            lastSyncedAt: now,
            updatedAt: now,
            deviceId: this.deviceId,
            appData: bundle
          };
          if (cleanTeacher) fsEmailPayload.teacherAccount = cleanTeacher;
          if (cleanAdmin) fsEmailPayload.adminAccount = cleanAdmin;
          await fsSetDoc(emailDocRef, fsEmailPayload, { merge: true });
        } catch (fsErr) {
          console.warn('Firestore saveAccountToCloud note:', fsErr);
        }
      }

      this.setActiveSyncEmail(cleanEmail);
      this.lastSyncedAt = now;
      localStorage.setItem('hss_last_cloud_sync', now);
      this.notify('synced');
      return true;
    } catch (err) {
      console.warn('Error saving account to cloud:', err);
      this.notify('error', err);
      return false;
    }
  }

  public async fetchFromCloud(user: FirebaseUser): Promise<{ found: boolean; data?: UserCloudBundle }> {
    try {
      this.notify('syncing');
      // 1. Fetch from Firestore users/{uid}
      if (firestore) {
        try {
          const fsSnap = await fsGetDoc(fsDoc(firestore, 'users', user.uid)).catch(() => null);
          if (fsSnap && fsSnap.exists()) {
            const fsData = fsSnap.data();
            if (fsData && fsData.appData) {
              const cloudBundle = fsData.appData as UserCloudBundle;
              this.applyCloudBundle(cloudBundle);
              this.lastSyncedAt = fsData.lastSyncedAt || cloudBundle.lastSyncedAt;
              if (user.email) {
                this.setActiveSyncEmail(user.email);
              }
              this.notify('synced');
              return { found: true, data: cloudBundle };
            }
          }
        } catch {}
      }

      // 2. Fetch from email_accounts
      if (user.email) {
        const emailRes = await this.fetchAccountByEmail(user.email);
        if (emailRes.found && emailRes.appData) {
          this.applyCloudBundle(emailRes.appData);
          this.setActiveSyncEmail(user.email);
          this.lastSyncedAt = emailRes.lastSyncedAt;
          this.notify('synced');
          return { found: true, data: emailRes.appData };
        }
      }

      // 3. Fetch from RTDB users/{uid} (Fallback)
      if (database) {
        const userRefPath = ref(database, 'users/' + user.uid);
        const snap = await get(userRefPath).catch(() => null);
        if (snap && snap.exists()) {
          const remote = snap.val();
          if (remote && remote.appData) {
            const cloudBundle = remote.appData as UserCloudBundle;
            this.applyCloudBundle(cloudBundle);
            this.lastSyncedAt = remote.lastSyncedAt || cloudBundle.lastSyncedAt;
            if (user.email) {
              this.setActiveSyncEmail(user.email);
            }
            this.notify('synced');
            return { found: true, data: cloudBundle };
          }
        }
      }

      if (user.email) {
        this.setActiveSyncEmail(user.email);
      }
      this.notify('synced');
      return { found: false };
    } catch (err: any) {
      console.warn('Cloud sync fetch note:', err);
      this.notify('error', err);
      return { found: false };
    }
  }

  public async forceFetchFromCloud(user: FirebaseUser): Promise<{ found: boolean; data?: UserCloudBundle }> {
    this.lastSyncedAt = undefined;
    localStorage.removeItem('hss_last_cloud_sync');
    return this.fetchFromCloud(user);
  }

  public startRealtimeSync(user: FirebaseUser, onDataRefreshed?: () => void) {
    this.stopRealtimeSync();
    if (user.email) {
      this.setActiveSyncEmail(user.email);
    }

    if (database) {
      try {
        const userRefPath = ref(database, 'users/' + user.uid);
        this.unsubscribeSnapshot = onValue(
          userRefPath,
          snapshot => {
            if (this.isApplyingRemoteUpdate) return;
            if (snapshot.exists()) {
              const data = snapshot.val();
              if (data && data.appData) {
                const updateDeviceId = data.deviceId || data.appData?.deviceId;
                const incomingTimestamp = data.lastSyncedAt || data.appData.lastSyncedAt;

                // Echo prevention: avoid re-processing updates generated by this device
                if (updateDeviceId && updateDeviceId === this.deviceId) {
                  if (incomingTimestamp) this.lastSyncedAt = incomingTimestamp;
                  return;
                }

                if (incomingTimestamp && incomingTimestamp !== this.lastSyncedAt) {
                  this.applyCloudBundle(data.appData, updateDeviceId);
                  this.lastSyncedAt = incomingTimestamp;
                  this.notify('synced');
                  if (onDataRefreshed) {
                    onDataRefreshed();
                  }
                }
              }
            }
          },
          error => {
            console.warn('RTDB snapshot listener note:', error);
          }
        );
      } catch (e) {
        console.warn('Could not establish RTDB snapshot listener', e);
      }
    }

    if (user.email) {
      this.startRealtimeEmailSync(user.email, onDataRefreshed);
    }
  }

  public startRealtimeEmailSync(email: string, onDataRefreshed?: () => void) {
    if (!email || !email.trim()) return;
    const cleanEmail = email.trim().toLowerCase();
    this.setActiveSyncEmail(cleanEmail);

    if (this.unsubscribeEmailSnapshot) {
      try {
        this.unsubscribeEmailSnapshot();
      } catch (e) {}
      this.unsubscribeEmailSnapshot = null;
    }

    const emailKey = this.sanitizeEmailKey(cleanEmail);
    if (database) {
      try {
        const emailRefPath = ref(database, 'email_accounts/' + emailKey);
        this.unsubscribeEmailSnapshot = onValue(
          emailRefPath,
          snapshot => {
            if (this.isApplyingRemoteUpdate) return;
            if (snapshot.exists()) {
              const data = snapshot.val();
              if (data && data.appData) {
                const updateDeviceId = data.deviceId || data.appData?.deviceId;
                const incomingTimestamp = data.lastSyncedAt || data.appData.lastSyncedAt;

                // Echo prevention: avoid re-processing updates generated by this device
                if (updateDeviceId && updateDeviceId === this.deviceId) {
                  if (incomingTimestamp) this.lastSyncedAt = incomingTimestamp;
                  return;
                }

                if (incomingTimestamp && incomingTimestamp !== this.lastSyncedAt) {
                  this.applyCloudBundle(data.appData, updateDeviceId);
                  this.lastSyncedAt = incomingTimestamp;
                  this.notify('synced');
                  if (onDataRefreshed) {
                    onDataRefreshed();
                  }
                }
              }
            }
          },
          error => {
            console.warn('RTDB email snapshot note:', error);
          }
        );
      } catch (e) {
        console.warn('Could not establish RTDB email snapshot listener', e);
      }
    }

    // Attach dual real-time listener on Firestore for maximum multi-device reliability
    if (this.unsubscribeFirestoreEmailSnapshot) {
      try {
        this.unsubscribeFirestoreEmailSnapshot();
      } catch (e) {}
      this.unsubscribeFirestoreEmailSnapshot = null;
    }

    if (firestore) {
      try {
        const docRef = fsDoc(firestore, 'email_accounts', emailKey);
        this.unsubscribeFirestoreEmailSnapshot = fsOnSnapshot(
          docRef,
          (docSnap: any) => {
            if (this.isApplyingRemoteUpdate) return;
            if (docSnap && docSnap.exists()) {
              const data = docSnap.data();
              if (data && data.appData) {
                const updateDeviceId = data.deviceId || data.appData?.deviceId;
                const incomingTimestamp = data.lastSyncedAt || data.appData.lastSyncedAt;

                if (updateDeviceId && updateDeviceId === this.deviceId) {
                  if (incomingTimestamp) this.lastSyncedAt = incomingTimestamp;
                  return;
                }

                if (incomingTimestamp && incomingTimestamp !== this.lastSyncedAt) {
                  this.applyCloudBundle(data.appData, updateDeviceId);
                  this.lastSyncedAt = incomingTimestamp;
                  this.notify('synced');
                  if (onDataRefreshed) {
                    onDataRefreshed();
                  }
                }
              }
            }
          },
          (fsErr: any) => {
            console.warn('Firestore real-time email listener note:', fsErr);
          }
        );
      } catch (e) {
        console.warn('Could not establish Firestore email snapshot listener', e);
      }
    }
  }

  public stopRealtimeSync() {
    if (this.unsubscribeSnapshot) {
      try {
        this.unsubscribeSnapshot();
      } catch (e) {}
      this.unsubscribeSnapshot = null;
    }
    if (this.unsubscribeEmailSnapshot) {
      try {
        this.unsubscribeEmailSnapshot();
      } catch (e) {}
      this.unsubscribeEmailSnapshot = null;
    }
    if (this.unsubscribeFirestoreEmailSnapshot) {
      try {
        this.unsubscribeFirestoreEmailSnapshot();
      } catch (e) {}
      this.unsubscribeFirestoreEmailSnapshot = null;
    }
    this.stopRealtimeBroadcasts();
  }

  public startRealtimeBroadcasts(schoolCode: string, onBroadcastsUpdated?: () => void) {
    if (!schoolCode) return;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);

    if (this.unsubscribeBroadcastsSnapshot) {
      try {
        this.unsubscribeBroadcastsSnapshot();
      } catch (e) {}
      this.unsubscribeBroadcastsSnapshot = null;
    }

    if (database) {
      try {
        const broadcastsRefPath = ref(database, 'broadcasts');
        this.unsubscribeBroadcastsSnapshot = onValue(
          broadcastsRefPath,
          snapshot => {
            const remoteBroadcasts: PrincipalBroadcast[] = [];
            if (snapshot.exists()) {
              snapshot.forEach(childSnap => {
                const b = childSnap.val() as PrincipalBroadcast;
                if (b && (!b.schoolCode || b.schoolCode.toUpperCase() === cleanCode)) {
                  remoteBroadcasts.push(b);
                }
              });
            }

            remoteBroadcasts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

            const localBroadcasts = StorageService.getPrincipalBroadcasts();
            const localIds = new Set(localBroadcasts.map(b => b.id));
            let changed = false;

            remoteBroadcasts.forEach(rb => {
              if (!localIds.has(rb.id)) {
                StorageService.addPrincipalBroadcast(rb);
                changed = true;
              }
            });

            if (changed && onBroadcastsUpdated) {
              onBroadcastsUpdated();
            }
          },
          error => {
            console.warn('Error syncing real-time broadcasts:', error);
          }
        );
      } catch (e) {
        console.warn('Could not establish real-time broadcasts listener', e);
      }
    }
  }

  public stopRealtimeBroadcasts() {
    if (this.unsubscribeBroadcastsSnapshot) {
      try {
        this.unsubscribeBroadcastsSnapshot();
      } catch (e) {}
      this.unsubscribeBroadcastsSnapshot = null;
    }
  }

  private unsubscribeSchoolTeachersSnapshot: (() => void) | null = null;
  private unsubscribeSchoolActivitiesSnapshot: (() => void) | null = null;

  public clearActiveSyncEmail() {
    this.setActiveSyncEmail(undefined);
    this.stopRealtimeSync();
    this.stopRealtimeBroadcasts();
    this.stopRealtimeSchoolSync();
  }

  public stopRealtimeSchoolSync() {
    if (this.unsubscribeSchoolTeachersSnapshot) {
      try {
        this.unsubscribeSchoolTeachersSnapshot();
      } catch (e) {}
      this.unsubscribeSchoolTeachersSnapshot = null;
    }
    if (this.unsubscribeSchoolActivitiesSnapshot) {
      try {
        this.unsubscribeSchoolActivitiesSnapshot();
      } catch (e) {}
      this.unsubscribeSchoolActivitiesSnapshot = null;
    }
  }

  public async saveTeacherToSchool(schoolCode: string, teacher: TeacherAccount): Promise<boolean> {
    if (!schoolCode || !teacher) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanGmail = (teacher.gmail || teacher.email || '').trim().toLowerCase();
    const effectiveTeacherKey = (teacher.uid || teacher.id || auth?.currentUser?.uid || '').trim();

    if (!effectiveTeacherKey) return false;

    const isPermDeleted = await this.isTeacherPermanentlyDeletedForSchool(cleanCode, effectiveTeacherKey, cleanGmail);
    if (isPermDeleted) {
      console.log('Teacher is permanently deleted for this school; ignoring re-entry save');
      return false;
    }

    StorageService.removeTemporarilyDeletedTeacherId(teacher.id, cleanGmail);
    if (teacher.uid) StorageService.removeTemporarilyDeletedTeacherId(teacher.uid);
    if (effectiveTeacherKey) StorageService.removeTemporarilyDeletedTeacherId(effectiveTeacherKey);

    const nowIso = new Date().toISOString();
    const rawPhotoUrl = String(teacher.photoUrl || '');
    const safePhotoUrl = !rawPhotoUrl.startsWith('data:') && rawPhotoUrl.length <= 1450 ? rawPhotoUrl : '';
    const sanitizedTeacherRecord: Record<string, any> = {
      id: effectiveTeacherKey,
      uid: effectiveTeacherKey,
      name: (teacher.name || 'Teacher').slice(0, 150),
      gmail: cleanGmail.slice(0, 200),
      email: cleanGmail.slice(0, 200),
      status: 'active',
      academicYear: String(teacher.academicYear || '').slice(0, 32),
      dob: String(teacher.dob || '').slice(0, 32),
      phone: String(teacher.phone || '').slice(0, 40),
      schoolName: String(teacher.schoolName || "St. Sebastian's Higher Secondary School").slice(0, 200),
      schoolCode: cleanCode,
      subject: String(teacher.subject || teacher.primarySubject || teacher.designation || '').slice(0, 100),
      primarySubject: String(teacher.primarySubject || teacher.subject || '').slice(0, 100),
      standard: String(teacher.standard || '').slice(0, 80),
      stream: String(teacher.stream || '').slice(0, 80),
      section: String(teacher.section || '').slice(0, 20),
      assignedClass: String(teacher.assignedClass || '').slice(0, 150),
      designation: String(teacher.designation || 'Class Teacher').slice(0, 120),
      avatar: String(teacher.avatar || '👨‍🏫').slice(0, 40),
      photoUrl: safePhotoUrl,
      updatedAt: nowIso,
      lastActiveAt: nowIso,
      recentActivity: String(teacher.recentActivity || `Active in ${teacher.assignedClass || 'Classroom'}`).slice(0, 500),
      studentCount: Number(teacher.studentCount) || 0,
      attendanceCount: Number(teacher.attendanceCount) || 0,
      examCount: Number(teacher.examCount) || 0
    };

    if (database) {
      try {
        await remove(ref(database, `schools/${cleanCode}/temporarilyDeletedTeachers/${effectiveTeacherKey}`)).catch(() => {});
        if (teacher.id && teacher.id !== effectiveTeacherKey) {
          await remove(ref(database, `schools/${cleanCode}/temporarilyDeletedTeachers/${teacher.id}`)).catch(() => {});
        }
        await remove(ref(database, `schools/${cleanCode}/deletedTeachers/${effectiveTeacherKey}`)).catch(() => {});

        await update(ref(database, `teachers/${effectiveTeacherKey}`), { ...sanitizedTeacherRecord, createdAt: teacher.createdAt || nowIso });
        await update(ref(database, `schools/${cleanCode}/teachers/${effectiveTeacherKey}`), { ...sanitizedTeacherRecord, createdAt: teacher.createdAt || nowIso });
        await update(ref(database, `teacherSignups/${effectiveTeacherKey}`), {
          fullName: teacher.name,
          email: cleanGmail,
          gmail: cleanGmail,
          dateOfBirth: teacher.dob || '',
          dob: teacher.dob || '',
          subject: teacher.subject || '',
          mobileNumber: teacher.phone || '',
          schoolCode: cleanCode,
          updatedAt: nowIso
        }).catch(() => {});
      } catch (err) {
        console.warn('Error saving teacher to RTDB:', err);
      }
    }

    if (firestore) {
      try {
        // Ensure user document exists with matching schoolCode BEFORE writing under schools/{schoolCode}
        if (auth?.currentUser?.uid === effectiveTeacherKey) {
          const existingUserSnap = await fsGetDoc(fsDoc(firestore, `users/${effectiveTeacherKey}`)).catch(() => null);
          const sessionRole = StorageService.getAuthSession().role;
          const preservedRole =
            existingUserSnap && existingUserSnap.exists()
              ? existingUserSnap.data()?.role || (sessionRole === 'admin' ? 'admin' : 'teacher')
              : sessionRole === 'admin'
                ? 'admin'
                : 'teacher';
          await fsSetDoc(fsDoc(firestore, `users/${effectiveTeacherKey}`), {
            userId: effectiveTeacherKey,
            uid: effectiveTeacherKey,
            email: cleanGmail || auth.currentUser.email || '',
            gmail: cleanGmail || auth.currentUser.email || '',
            role: preservedRole,
            schoolCode: cleanCode,
            schoolName: sanitizedTeacherRecord.schoolName,
            displayName: sanitizedTeacherRecord.name,
            name: sanitizedTeacherRecord.name,
            dob: sanitizedTeacherRecord.dob,
            phone: sanitizedTeacherRecord.phone,
            updatedAt: nowIso
          }, { merge: true });
        }

        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}`), {
          schoolCode: cleanCode,
          schoolName: sanitizedTeacherRecord.schoolName,
          updatedAt: nowIso
        }, { merge: true });

        const [existingSchoolTeacherSnap, existingSignupSnap] = await Promise.all([
          fsGetDoc(fsDoc(firestore, `schools/${cleanCode}/teachers/${effectiveTeacherKey}`)).catch(() => null),
          fsGetDoc(fsDoc(firestore, `schools/${cleanCode}/teacherSignups/${effectiveTeacherKey}`)).catch(() => null)
        ]);

        const teacherWritePayload =
          existingSchoolTeacherSnap && existingSchoolTeacherSnap.exists()
            ? sanitizedTeacherRecord
            : { ...sanitizedTeacherRecord, createdAt: teacher.createdAt || nowIso };

        const baseSignupPayload = {
          ...sanitizedTeacherRecord,
          fullName: (teacher.name || 'Teacher').slice(0, 150),
          dateOfBirth: String(teacher.dob || '').slice(0, 32),
          mobileNumber: String(teacher.phone || '').slice(0, 40),
          role: 'teacher',
          updatedAt: nowIso
        };

        const signupWritePayload =
          existingSignupSnap && existingSignupSnap.exists()
            ? baseSignupPayload
            : { ...baseSignupPayload, createdAt: teacher.createdAt || nowIso };

        await Promise.all([
          fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/teachers/${effectiveTeacherKey}`), teacherWritePayload, { merge: true }),
          fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/teacherSignups/${effectiveTeacherKey}`), signupWritePayload, { merge: true }),
          fsSetDoc(fsDoc(firestore, `teachers/${effectiveTeacherKey}`), teacherWritePayload, { merge: true }),
          fsSetDoc(fsDoc(firestore, `teacherSignups/${effectiveTeacherKey}`), signupWritePayload, { merge: true })
        ]);
      } catch (fsErr) {
        console.error('Firestore saveTeacherToSchool error:', fsErr);
        handleFirestoreError(fsErr, OperationType.WRITE, `schools/${cleanCode}/teachers/${effectiveTeacherKey}`);
      }
    }

    return true;
  }

  public async temporaryDeleteTeacherFromSchool(
    schoolCode: string,
    teacherId: string,
    teacherEmail?: string,
    teacherUid?: string
  ): Promise<boolean> {
    if (!schoolCode || !teacherId) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanEmail = (teacherEmail || '').trim().toLowerCase();

    // Track temporary delete in local storage
    StorageService.addTemporarilyDeletedTeacherId(teacherId, cleanEmail);
    if (teacherUid) StorageService.addTemporarilyDeletedTeacherId(teacherUid);

    if (database) {
      try {
        // Retrieve existing teacher profile so we can store it in temporarilyDeletedTeachers for seamless re-entry
        let teacherProfile: any = null;
        const snap = await get(ref(database, `schools/${cleanCode}/teachers/${teacherId}`)).catch(() => null);
        if (snap && snap.exists()) {
          teacherProfile = snap.val();
        }
        if (!teacherProfile && teacherUid) {
          const snapUid = await get(ref(database, `schools/${cleanCode}/teachers/${teacherUid}`)).catch(() => null);
          if (snapUid && snapUid.exists()) {
            teacherProfile = snapUid.val();
          }
        }
        if (!teacherProfile && cleanEmail) {
          const allSnap = await get(ref(database, `schools/${cleanCode}/teachers`)).catch(() => null);
          if (allSnap && allSnap.exists()) {
            allSnap.forEach(child => {
              const val = child.val();
              if (val && ((val.email && val.email.toLowerCase() === cleanEmail) || (val.gmail && val.gmail.toLowerCase() === cleanEmail))) {
                teacherProfile = val;
              }
            });
          }
        }

        const effectiveUid = teacherProfile?.uid || teacherUid || teacherId;
        const recordToSave = teacherProfile ? {
          ...teacherProfile,
          id: effectiveUid,
          uid: effectiveUid,
          email: cleanEmail || teacherProfile.email || teacherProfile.gmail || '',
          gmail: cleanEmail || teacherProfile.gmail || teacherProfile.email || '',
          temporarilyDeleted: true,
          status: 'temporary_deleted',
          deletedAt: new Date().toISOString()
        } : {
          id: effectiveUid,
          uid: effectiveUid,
          email: cleanEmail,
          gmail: cleanEmail,
          temporarilyDeleted: true,
          status: 'temporary_deleted',
          deletedAt: new Date().toISOString()
        };

        // Store full profile in temporarilyDeletedTeachers in RTDB
        await set(ref(database, `schools/${cleanCode}/temporarilyDeletedTeachers/${effectiveUid}`), recordToSave);
        if (teacherId !== effectiveUid) {
          await set(ref(database, `schools/${cleanCode}/temporarilyDeletedTeachers/${teacherId}`), recordToSave).catch(() => {});
        }

        // Remove from active teachers in RTDB
        await remove(ref(database, `schools/${cleanCode}/teachers/${teacherId}`)).catch(() => {});
        if (effectiveUid !== teacherId) {
          await remove(ref(database, `schools/${cleanCode}/teachers/${effectiveUid}`)).catch(() => {});
        }
        if (cleanEmail) {
          const allSnap = await get(ref(database, `schools/${cleanCode}/teachers`)).catch(() => null);
          if (allSnap && allSnap.exists()) {
            allSnap.forEach(child => {
              const val = child.val();
              if (val && ((val.email && val.email.toLowerCase() === cleanEmail) || (val.gmail && val.gmail.toLowerCase() === cleanEmail))) {
                remove(ref(database, `schools/${cleanCode}/teachers/${child.key}`)).catch(() => {});
              }
            });
          }
        }
      } catch (err) {
        console.warn('Error temporarily deleting teacher in RTDB:', err);
      }
    }

    if (firestore) {
      try {
        const effectiveUid = teacherUid || teacherId;
        const teacherDocRef = fsDoc(firestore, `schools/${cleanCode}/teachers/${effectiveUid}`);
        await fsDeleteDoc(teacherDocRef).catch(() => {});
        const tempDeletedDocRef = fsDoc(firestore, `schools/${cleanCode}/temporarilyDeletedTeachers/${effectiveUid}`);
        await fsSetDoc(tempDeletedDocRef, {
          id: effectiveUid,
          uid: effectiveUid,
          email: cleanEmail,
          temporarilyDeleted: true,
          deletedAt: new Date().toISOString()
        }, { merge: true }).catch(() => {});
      } catch (fsErr) {
        console.warn('Firestore temporaryDeleteTeacherFromSchool warning:', fsErr);
      }
    }

    return true;
  }

  public async isTeacherPermanentlyDeletedForSchool(
    schoolCode: string,
    uid?: string,
    email?: string
  ): Promise<boolean> {
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanUid = (uid || '').trim();

    // Prevent pre-authorized admins from ever being permanently blocked from teacher access
    const PRE_AUTHORIZED_EMAILS = new Set([
      'gelwin72@gmail.com',
      'joicegeorge1910@gmail.com',
      'lincythomas1911@gmail.com'
    ]);
    if (cleanEmail && PRE_AUTHORIZED_EMAILS.has(cleanEmail)) {
      return false;
    }

    if (StorageService.isTeacherPermanentlyDeleted(cleanUid, cleanEmail)) {
      return true;
    }

    if (database) {
      try {
        if (cleanUid) {
          const snapUid = await get(ref(database, `schools/${cleanCode}/permanentlyDeletedTeachers/${cleanUid}`)).catch(() => null);
          if (snapUid && snapUid.exists() && (snapUid.val() === true || snapUid.val()?.permanentlyDeleted === true)) {
            StorageService.addPermanentlyDeletedTeacherId(cleanUid, cleanEmail);
            return true;
          }
        }
        if (cleanEmail) {
          const sanitizedEmail = this.sanitizeEmailKey(cleanEmail);
          const snapEmail = await get(ref(database, `schools/${cleanCode}/permanentlyDeletedTeacherEmails/${sanitizedEmail}`)).catch(() => null);
          if (snapEmail && snapEmail.exists() && (snapEmail.val() === true || snapEmail.val()?.permanentlyDeleted === true)) {
            StorageService.addPermanentlyDeletedTeacherId(cleanUid, cleanEmail);
            return true;
          }
        }
      } catch (e) {
        console.warn('RTDB perm delete check note:', e);
      }
    }

    if (firestore) {
      try {
        if (cleanUid) {
          const docRef = fsDoc(firestore, `schools/${cleanCode}/permanentlyDeletedTeachers/${cleanUid}`);
          const docSnap = await fsGetDoc(docRef).catch(() => null);
          if (docSnap && docSnap.exists() && docSnap.data()?.permanentlyDeleted === true) {
            StorageService.addPermanentlyDeletedTeacherId(cleanUid, cleanEmail);
            return true;
          }
        }
      } catch (e) {
        console.warn('Firestore perm delete check note:', e);
      }
    }

    return false;
  }

  public async isEmailAuthorizedAdmin(schoolCode: string, email: string): Promise<boolean> {
    if (!email) return false;
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = this.sanitizeSchoolCode(schoolCode);

    const PRE_AUTHORIZED = new Set([
      'gelwin72@gmail.com',
      'joicegeorge1910@gmail.com'
    ]);
    if (PRE_AUTHORIZED.has(cleanEmail)) return true;

    if (database) {
      try {
        const adminSnap = await get(ref(database, `schools/${cleanCode}/schoolAdmins`)).catch(() => null);
        if (adminSnap && adminSnap.exists()) {
          let found = false;
          adminSnap.forEach(child => {
            const val = child.val();
            if (val && val.email && val.email.toLowerCase() === cleanEmail) {
              found = true;
            }
          });
          if (found) return true;
        }
      } catch (e) {}
    }
    return false;
  }

  public async permanentDeleteTeacherFromSchool(
    schoolCode: string,
    teacherId: string,
    teacherEmail?: string,
    teacherUid?: string
  ): Promise<boolean> {
    if (!schoolCode || !teacherId) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanEmail = (teacherEmail || '').trim().toLowerCase();
    const sanitizedEmail = cleanEmail ? this.sanitizeEmailKey(cleanEmail) : '';
    const effectiveUid = teacherUid || teacherId;

    // Track permanent delete in local storage for teacher membership
    StorageService.addPermanentlyDeletedTeacherId(teacherId, cleanEmail);
    if (teacherUid) StorageService.addPermanentlyDeletedTeacherId(teacherUid);

    if (database) {
      try {
        // Remove from active teachers in RTDB
        await remove(ref(database, `teachers/${teacherId}`)).catch(() => {});
        if (effectiveUid !== teacherId) {
          await remove(ref(database, `teachers/${effectiveUid}`)).catch(() => {});
        }

        await remove(ref(database, `schools/${cleanCode}/teachers/${teacherId}`)).catch(() => {});
        if (effectiveUid !== teacherId) {
          await remove(ref(database, `schools/${cleanCode}/teachers/${effectiveUid}`)).catch(() => {});
        }

        // Clean any matches by email in schools/{cleanCode}/teachers
        if (cleanEmail) {
          const allSnap = await get(ref(database, `schools/${cleanCode}/teachers`)).catch(() => null);
          if (allSnap && allSnap.exists()) {
            allSnap.forEach(child => {
              const val = child.val();
              if (val && ((val.email && val.email.toLowerCase() === cleanEmail) || (val.gmail && val.gmail.toLowerCase() === cleanEmail))) {
                remove(ref(database, `schools/${cleanCode}/teachers/${child.key}`)).catch(() => {});
              }
            });
          }
        }

        // Remove from temporarily deleted teachers
        await remove(ref(database, `schools/${cleanCode}/temporarilyDeletedTeachers/${teacherId}`)).catch(() => {});
        if (effectiveUid !== teacherId) {
          await remove(ref(database, `schools/${cleanCode}/temporarilyDeletedTeachers/${effectiveUid}`)).catch(() => {});
        }

        // Record permanent deletion
        const permRecord = { permanentlyDeleted: true, email: cleanEmail, deletedAt: new Date().toISOString() };
        await set(ref(database, `schools/${cleanCode}/permanentlyDeletedTeachers/${teacherId}`), permRecord);
        if (effectiveUid !== teacherId) {
          await set(ref(database, `schools/${cleanCode}/permanentlyDeletedTeachers/${effectiveUid}`), permRecord);
        }

        if (sanitizedEmail) {
          const deletedEmailRef = ref(database, `schools/${cleanCode}/permanentlyDeletedTeacherEmails/${sanitizedEmail}`);
          await set(deletedEmailRef, { permanentlyDeleted: true, uid: effectiveUid, deletedAt: new Date().toISOString() });
        }
      } catch (err) {
        console.warn('Error permanently deleting teacher from RTDB:', err);
      }
    }

    if (firestore) {
      try {
        const teacherDocRef = fsDoc(firestore, `schools/${cleanCode}/teachers/${effectiveUid}`);
        await fsDeleteDoc(teacherDocRef).catch(() => {});
        const permDeletedDocRef = fsDoc(firestore, `schools/${cleanCode}/permanentlyDeletedTeachers/${effectiveUid}`);
        await fsSetDoc(permDeletedDocRef, {
          id: effectiveUid,
          uid: effectiveUid,
          email: cleanEmail,
          permanentlyDeleted: true,
          deletedAt: new Date().toISOString()
        }, { merge: true }).catch(() => {});
      } catch (fsErr) {
        console.warn('Firestore permanentDeleteTeacherFromSchool warning:', fsErr);
      }
    }

    // Teacher Membership and School Admin Authorization are completely separate.
    // We NEVER delete or modify the Firebase Auth account or School Admin record here.
    return true;
  }

  public async deleteTeacherFromSchool(
    schoolCode: string,
    teacherId: string,
    teacherEmail?: string,
    isPermanent: boolean = true,
    teacherUid?: string
  ): Promise<boolean> {
    if (isPermanent) {
      return this.permanentDeleteTeacherFromSchool(schoolCode, teacherId, teacherEmail, teacherUid);
    } else {
      return this.temporaryDeleteTeacherFromSchool(schoolCode, teacherId, teacherEmail, teacherUid);
    }
  }

  public async cleanupOldDeletedTeachers(schoolCode: string): Promise<void> {
    if (!schoolCode) return;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);

    try {
      let permDeletedIds: string[] = [];
      if (database) {
        const permSnap = await get(ref(database, `schools/${cleanCode}/permanentlyDeletedTeachers`)).catch(() => null);
        if (permSnap && permSnap.exists()) {
          const val = permSnap.val();
          if (typeof val === 'object' && val !== null) {
            permDeletedIds = Object.keys(val);
          }
        }
        const delSnap = await get(ref(database, `schools/${cleanCode}/deletedTeachers`)).catch(() => null);
        if (delSnap && delSnap.exists()) {
          const val = delSnap.val();
          if (typeof val === 'object' && val !== null) {
            permDeletedIds = Array.from(new Set([...permDeletedIds, ...Object.keys(val)]));
          }
        }
      }

      const activeTeachers = await this.fetchSchoolTeachers(cleanCode);
      for (const t of activeTeachers) {
        if (!t) continue;
        const tId = t.id || t.uid || '';
        const tEmail = (t.email || t.gmail || '').trim().toLowerCase();

        if (
          permDeletedIds.includes(tId) ||
          (tEmail && permDeletedIds.includes(tEmail)) ||
          (t as any).status === 'deleted' ||
          (t as any).status === 'permanently_deleted'
        ) {
          if (database && tId) {
            await remove(ref(database, `schools/${cleanCode}/teachers/${tId}`)).catch(() => {});
            await remove(ref(database, `teachers/${tId}`)).catch(() => {});
          }
          if (firestore && tId) {
            await fsDeleteDoc(fsDoc(firestore, `schools/${cleanCode}/teachers/${tId}`)).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.warn('Cleanup old deleted teachers note:', e);
    }
  }

  public async saveClassToSchool(schoolCode: string, classItem: ClassItem, students?: Student[]): Promise<boolean> {
    if (!schoolCode || !classItem || !classItem.id) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const uid = auth?.currentUser?.uid || classItem.teacherUid || classItem.teacherId || '';
    const nowIso = new Date().toISOString();

    const fsClassPayload: Record<string, any> = {
      id: classItem.id,
      className: classItem.className || 'Class',
      standard: classItem.standard || '',
      stream: classItem.stream || '',
      section: classItem.section || '',
      academicYear: classItem.academicYear || '',
      classStrength: students ? students.length : (classItem.classStrength || 0),
      teacherId: classItem.teacherId || uid,
      teacherUid: classItem.teacherUid || uid,
      teacherName: classItem.teacherName || '',
      schoolCode: cleanCode,
      isTeacherCreated: Boolean(classItem.isTeacherCreated ?? true),
      createdByTeacherId: classItem.createdByTeacherId || classItem.teacherId || uid,
      createdByTeacherEmail: classItem.createdByTeacherEmail || '',
      attendanceCount: classItem.attendanceCount || 0,
      examCount: classItem.examCount || 0,
      createdAt: classItem.createdAt || nowIso,
      updatedAt: nowIso
    };

    if (database) {
      try {
        const classRefPath = ref(database, `schools/${cleanCode}/classes/${classItem.id}`);
        await set(classRefPath, { ...fsClassPayload, ...(students ? { students } : {}) });
        if (students && students.length > 0) {
          const studsRefPath = ref(database, `schools/${cleanCode}/classes/${classItem.id}/students`);
          await set(studsRefPath, students);
        }
      } catch (e) {
        console.warn('RTDB saveClassToSchool warning:', e);
      }
    }

    if (firestore) {
      try {
        const batch = fsWriteBatch(firestore);
        const docRef = fsDoc(firestore, `schools/${cleanCode}/classes/${classItem.id}`);
        batch.set(docRef, fsClassPayload, { merge: true });
        if (students && students.length > 0) {
          for (const s of students) {
            if (s && s.id) {
              const sRef = fsDoc(firestore, `schools/${cleanCode}/classes/${classItem.id}/students/${s.id}`);
              batch.set(sRef, this.sanitizeStudentPayload(s, classItem.id, cleanCode, uid), { merge: true });
            }
          }
        }
        await batch.commit();
      } catch (e) {
        console.error('Firestore saveClassToSchool error:', e);
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/classes/${classItem.id}`);
      }
    }

    return true;
  }

  public async syncAllTeacherClassesToSchool(schoolCode: string, teacherId?: string, teacherEmail?: string): Promise<void> {
    if (!schoolCode) return;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const localClasses = StorageService.getClassesList();
    const cleanEmail = (teacherEmail || '').trim().toLowerCase();

    for (const cls of localClasses) {
      if (!cls || !cls.id) continue;
      const isOwner = (
        (teacherId && (cls.createdByTeacherId === teacherId || cls.teacherId === teacherId || cls.teacherUid === teacherId)) ||
        (cleanEmail && cls.createdByTeacherEmail && cls.createdByTeacherEmail.trim().toLowerCase() === cleanEmail) ||
        cls.isTeacherCreated
      );

      if (isOwner) {
        const enrichedClass: ClassItem = {
          ...cls,
          schoolCode: cleanCode,
          isTeacherCreated: true,
          createdByTeacherId: cls.createdByTeacherId || cls.teacherId || teacherId || '',
          teacherId: cls.teacherId || cls.createdByTeacherId || teacherId || '',
          teacherUid: cls.teacherUid || teacherId || cls.createdByTeacherId || cls.teacherId || '',
          createdByTeacherEmail: cls.createdByTeacherEmail || cleanEmail || ''
        };
        const studs = StorageService.getStudents(cls.id);
        await this.saveClassToSchool(cleanCode, enrichedClass, studs);
      }
    }
  }

  public async deleteClassFromSchool(schoolCode: string, classId: string): Promise<boolean> {
    if (!schoolCode || !classId) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);

    if (database) {
      try {
        const classRefPath = ref(database, `schools/${cleanCode}/classes/${classId}`);
        await remove(classRefPath);
      } catch (e) {
        console.warn('RTDB deleteClassFromSchool warning:', e);
      }
    }

    if (firestore) {
      try {
        const docRef = fsDoc(firestore, `schools/${cleanCode}/classes/${classId}`);
        await fsDeleteDoc(docRef);
      } catch (e) {
        console.error('Firestore deleteClassFromSchool error:', e);
        handleFirestoreError(e, OperationType.DELETE, `schools/${cleanCode}/classes/${classId}`);
      }
    }

    return true;
  }

  public listenToSchoolClasses(
    schoolCode: string,
    onClassesUpdated: (classes: ClassItem[]) => void
  ): () => void {
    if (!schoolCode) return () => {};
    const cleanCode = this.sanitizeSchoolCode(schoolCode);

    let unsubFs: (() => void) | null = null;
    if (firestore) {
      try {
        const colRef = fsCollection(firestore, `schools/${cleanCode}/classes`);
        unsubFs = fsOnSnapshot(colRef, (snapshot) => {
          const list: ClassItem[] = [];
          snapshot.forEach((d: any) => {
            const val = d.data();
            if (val) {
              const classId = val.id || d.id;
              list.push({ ...val, id: classId });
              
              // Extract and restore students if they are embedded in the class record
              if (val.students && Array.isArray(val.students) && val.students.length > 0) {
                StorageService.saveStudents(val.students, classId);
              }
            }
          });
          StorageService.saveClassesList(list);
          onClassesUpdated(list);
        }, err => console.warn('Firestore listenToSchoolClasses warning:', err));
      } catch (e) {
        console.warn('Firestore listenToSchoolClasses setup error:', e);
      }
    }

    let unsubRtdb: (() => void) | null = null;
    if (database) {
      try {
        const classesRefPath = ref(database, `schools/${cleanCode}/classes`);
        unsubRtdb = onValue(classesRefPath, snapshot => {
          const list: ClassItem[] = [];
          if (snapshot.exists()) {
            snapshot.forEach(child => {
              const c = child.val();
              if (c) {
                list.push(c);
                // Extract and restore students if they are embedded
                if (c.students && Array.isArray(c.students) && c.students.length > 0) {
                  StorageService.saveStudents(c.students, c.id);
                }
              }
            });
          }
          StorageService.saveClassesList(list);
          onClassesUpdated(list);
        });
      } catch (e) {}
    }

    return () => {
      if (unsubFs) unsubFs();
      if (unsubRtdb) unsubRtdb();
    };
  }

  /**
   * Fetches complete cloud data across RTDB and Firestore in parallel.
   * Restores all classroom data, teacher profiles, school configuration, and student rosters.
   */
  public async fetchCompleteUserCloudData(
    uid?: string,
    email?: string,
    schoolCode?: string
  ): Promise<{
    found: boolean;
    bundle?: UserCloudBundle;
    teacherAccount?: TeacherAccount;
    adminAccount?: SchoolAdminAccount;
    role?: 'teacher' | 'admin';
  }> {
    const cleanUid = (uid || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanSchool = schoolCode ? this.sanitizeSchoolCode(schoolCode, '') : '';

    if (!cleanUid && !cleanEmail) {
      return { found: false };
    }

    let foundBundle: UserCloudBundle | null = null;
    let foundTeacher: TeacherAccount | null = null;
    let foundAdmin: SchoolAdminAccount | null = null;
    let foundRole: 'teacher' | 'admin' = 'teacher';

    const lookups: Promise<any>[] = [];

    // RTDB users/{uid}
    if (database && cleanUid) {
      lookups.push(
        get(ref(database, 'users/' + cleanUid))
          .then(snap => {
            if (snap.exists()) {
              const val = snap.val();
              if (val?.appData && !foundBundle) {
                foundBundle = val.appData as UserCloudBundle;
              }
              if (val?.teacherAccount && !foundTeacher) {
                foundTeacher = val.teacherAccount;
              }
            }
          })
          .catch(() => null)
      );
    }

    // RTDB email_accounts/{emailKey}
    if (database && cleanEmail) {
      const emailKey = this.sanitizeEmailKey(cleanEmail);
      lookups.push(
        get(ref(database, 'email_accounts/' + emailKey))
          .then(snap => {
            if (snap.exists()) {
              const val = snap.val();
              if (val?.appData && !foundBundle) {
                foundBundle = val.appData as UserCloudBundle;
              }
              if (val?.teacherAccount && !foundTeacher) {
                foundTeacher = val.teacherAccount;
              }
              if (val?.adminAccount && !foundAdmin) {
                foundAdmin = val.adminAccount;
              }
              if (val?.role) {
                foundRole = val.role;
              }
            }
          })
          .catch(() => null)
      );
    }

    // Firestore email_accounts/{emailKey} & teacher_credentials/{emailKey} (fastest cross-device restore)
    if (firestore && cleanEmail) {
      const emailKey = this.sanitizeEmailKey(cleanEmail);
      lookups.push(
        fsGetDoc(fsDoc(firestore, 'email_accounts', emailKey))
          .then(snap => {
            if (snap.exists()) {
              const val = snap.data();
              if (val?.appData && !foundBundle) {
                foundBundle = val.appData as UserCloudBundle;
              }
              if (val?.teacherAccount && !foundTeacher) {
                foundTeacher = val.teacherAccount;
              }
              if (val?.adminAccount && !foundAdmin) {
                foundAdmin = val.adminAccount;
              }
              if (val?.role) {
                foundRole = val.role;
              }
            }
          })
          .catch(() => null)
      );
      lookups.push(
        fsGetDoc(fsDoc(firestore, 'teacher_credentials', emailKey))
          .then(snap => {
            if (snap.exists()) {
              const val = snap.data() as any;
              if (val && !foundTeacher) {
                foundTeacher = {
                  id: val.teacherId || val.uid || `teacher-${emailKey}`,
                  uid: val.uid || val.teacherId,
                  name: val.name || 'Teacher',
                  email: cleanEmail,
                  gmail: cleanEmail,
                  dob: val.dob || val.dateOfBirth || '',
                  phone: val.phone || '',
                  schoolName: val.schoolName || "St. Sebastian's Higher Secondary School",
                  schoolCode: val.schoolCode || cleanSchool || 'SSHSS@111213',
                  subject: val.subject || 'General',
                  assignedClass: val.assignedClass || '',
                  designation: val.designation || 'Teacher',
                  status: 'active',
                  createdAt: val.createdAt || new Date().toISOString()
                };
              }
            }
          })
          .catch(() => null)
      );
      lookups.push(
        fsGetDocs(fsQuery(fsCollection(firestore, 'teachers'), fsWhere('email', '==', cleanEmail)))
          .then(qSnap => {
            if (!qSnap.empty && !foundTeacher) {
              const val = qSnap.docs[0].data() as TeacherAccount;
              if (val) foundTeacher = val;
            }
          })
          .catch(() => null)
      );
    }

    // Firestore users/{uid}
    if (firestore && cleanUid) {
      lookups.push(
        fsGetDoc(fsDoc(firestore, 'users', cleanUid))
          .then(snap => {
            if (snap.exists()) {
              const val = snap.data();
              if (val?.appData && !foundBundle) {
                foundBundle = val.appData as UserCloudBundle;
              }
              if (val?.teacherAccount && !foundTeacher) {
                foundTeacher = val.teacherAccount;
              }
              if (val?.adminAccount && !foundAdmin) {
                foundAdmin = val.adminAccount;
              }
              if (val?.role) {
                foundRole = val.role;
              }
            }
          })
          .catch(() => null)
      );
    }

    // Firestore query users by email
    if (firestore && cleanEmail) {
      lookups.push(
        fsGetDocs(fsQuery(fsCollection(firestore, 'users'), fsWhere('email', '==', cleanEmail)))
          .then(querySnap => {
            if (!querySnap.empty) {
              const docData = querySnap.docs[0].data();
              if (docData?.appData && !foundBundle) {
                foundBundle = docData.appData as UserCloudBundle;
              }
              if (docData?.teacherAccount && !foundTeacher) {
                foundTeacher = docData.teacherAccount;
              }
              if (docData?.role) {
                foundRole = docData.role;
              }
            }
          })
          .catch(() => null)
      );
    }

    // RTDB teacher lookup in teachers/ and schools/{cleanSchool}/teachers
    if (database) {
      if (cleanSchool) {
        lookups.push(
          get(ref(database, `schools/${cleanSchool}/teachers`))
            .then(snap => {
              if (snap.exists()) {
                snap.forEach(child => {
                  const val = child.val() as TeacherAccount;
                  const tEmail = (val?.email || val?.gmail || '').trim().toLowerCase();
                  const tUid = val?.uid || val?.id || child.key;
                  if ((cleanEmail && tEmail === cleanEmail) || (cleanUid && tUid === cleanUid)) {
                    if (!foundTeacher) foundTeacher = val;
                  }
                });
              }
            })
            .catch(() => null)
        );
      }
      lookups.push(
        get(ref(database, 'teachers'))
          .then(snap => {
            if (snap.exists()) {
              snap.forEach(child => {
                const val = child.val() as TeacherAccount;
                const tEmail = (val?.email || val?.gmail || '').trim().toLowerCase();
                const tUid = val?.uid || val?.id || child.key;
                if ((cleanEmail && tEmail === cleanEmail) || (cleanUid && tUid === cleanUid)) {
                  if (!foundTeacher) foundTeacher = val;
                }
              });
            }
          })
          .catch(() => null)
      );
    }

    await Promise.race([
      Promise.allSettled(lookups),
      new Promise<void>(resolve => setTimeout(resolve, 3500))
    ]);

    if (foundBundle) {
      this.applyCloudBundle(foundBundle);

      if (!foundTeacher && foundBundle.teacherAccounts && foundBundle.teacherAccounts.length > 0) {
        foundTeacher = foundBundle.teacherAccounts.find(t =>
          (cleanEmail && (t.email?.toLowerCase() === cleanEmail || t.gmail?.toLowerCase() === cleanEmail)) ||
          (cleanUid && (t.id === cleanUid || t.uid === cleanUid))
        ) || foundBundle.teacherAccounts[0];
      }

      if (!foundTeacher && foundBundle.teacherInfo) {
        foundTeacher = {
          id: cleanUid || `teach-${Date.now()}`,
          uid: cleanUid || undefined,
          name: foundBundle.teacherInfo.teacherName || 'Teacher',
          email: cleanEmail || foundBundle.teacherInfo.email || '',
          gmail: cleanEmail || foundBundle.teacherInfo.email || '',
          phone: foundBundle.teacherInfo.phone || '',
          schoolName: foundBundle.schoolProfile.schoolName || "St. Sebastian's Higher Secondary School",
          schoolCode: cleanSchool || foundBundle.schoolProfile.schoolCode || 'SSHSS@111213',
          subject: foundBundle.teacherInfo.designation || 'General',
          designation: foundBundle.teacherInfo.designation || 'Class Teacher',
          status: 'active',
          academicYear: foundBundle.teacherInfo.academicYear || '2026-2027',
          createdAt: new Date().toISOString()
        };
      }

      return {
        found: true,
        bundle: foundBundle,
        teacherAccount: foundTeacher || undefined,
        adminAccount: foundAdmin || undefined,
        role: foundRole
      };
    }

    if (foundTeacher) {
      return {
        found: true,
        teacherAccount: foundTeacher,
        role: 'teacher'
      };
    }

    return { found: false };
  }

  /**
   * Restores a teacher's classroom permanently associated with their Firebase UID / user account.
   * Guarantees:
   * 1. Restores the exact same classroom the teacher originally created.
   * 2. Prevents creating duplicate or dummy copies of the classroom.
   * 3. Completely restores associated students, attendance, exams, and marks.
   * 4. Permanently selects and displays the restored classroom as active.
   */
  public async restoreTeacherClassroom(
    teacherUid: string,
    teacherEmail?: string,
    schoolCode?: string
  ): Promise<{
    success: boolean;
    activeClassId?: string;
    classItem?: ClassItem;
    classes: ClassItem[];
  }> {
    const cleanUid = (teacherUid || '').trim();
    const cleanEmail = (teacherEmail || '').trim().toLowerCase();
    const cleanSchool = schoolCode ? this.sanitizeSchoolCode(schoolCode, '') : '';

    if (!cleanUid && !cleanEmail) {
      const localClasses = StorageService.getClassesList();
      const activeId = StorageService.getActiveClassId();
      const activeItem = localClasses.find(c => c.id === activeId);
      return { success: false, activeClassId: activeId, classItem: activeItem, classes: localClasses };
    }

    try {
      // 1. Fetch complete cloud data (parallel lookup across RTDB & Firestore)
      const cloudRes = await this.fetchCompleteUserCloudData(cleanUid, cleanEmail, cleanSchool);
      const foundBundle = cloudRes.bundle || null;

      // 2. Query school classes from RTDB & Firestore concurrently
      const retrievedClasses: ClassItem[] = [];
      const retrievedStudentsMap: Record<string, Student[]> = {};

      // Seed with classes from foundBundle
      if (foundBundle?.classesCatalog && Array.isArray(foundBundle.classesCatalog)) {
        foundBundle.classesCatalog.forEach(c => {
          if (c && c.id) {
            retrievedClasses.push(c);
            const studs = foundBundle?.classData?.[c.id]?.students;
            if (studs && Array.isArray(studs) && studs.length > 0) {
              retrievedStudentsMap[c.id] = studs;
            }
          }
        });
      }

      const schoolLookups: Promise<any>[] = [];

      // RTDB school classes query
      if (database && cleanSchool) {
        schoolLookups.push(
          get(ref(database, `schools/${cleanSchool}/classes`))
            .then(schoolSnap => {
              if (schoolSnap.exists()) {
                schoolSnap.forEach(child => {
                  const val = child.val();
                  if (val && val.id) {
                    const cUid = val.teacherUid || val.teacherId || val.createdByTeacherId || '';
                    const cEmail = (val.createdByTeacherEmail || '').trim().toLowerCase();
                    const isMatch = (cleanUid && cUid === cleanUid) || (cleanEmail && cEmail === cleanEmail);
                    if (isMatch) {
                      if (!retrievedClasses.some(c => c.id === val.id)) {
                        retrievedClasses.push(val as ClassItem);
                      }
                      if (val.students && Array.isArray(val.students)) {
                        retrievedStudentsMap[val.id] = val.students;
                      }
                    }
                  }
                });
              }
            })
            .catch(e => console.warn('RTDB school classes query note:', e))
        );
      }

      // Firestore school classes query
      if (firestore && cleanSchool) {
        schoolLookups.push(
          fsGetDocs(fsCollection(firestore, `schools/${cleanSchool}/classes`))
            .then(fsDocs => {
              fsDocs.forEach((d: any) => {
                const val = d.data();
                if (val && (val.id || d.id)) {
                  const id = val.id || d.id;
                  const cUid = val.teacherUid || val.teacherId || val.createdByTeacherId || '';
                  const cEmail = (val.createdByTeacherEmail || '').trim().toLowerCase();
                  const isMatch = (cleanUid && cUid === cleanUid) || (cleanEmail && cEmail === cleanEmail);
                  if (isMatch && !retrievedClasses.some(c => c.id === id)) {
                    retrievedClasses.push({ ...val, id });
                  }
                  if (val.students && Array.isArray(val.students)) {
                    retrievedStudentsMap[id] = val.students;
                  }
                }
              });
            })
            .catch(e => console.warn('Firestore school classes query note:', e))
        );
      }

      // Teacher signups metadata query in RTDB
      let signupClassMeta: { className?: string; standard?: string; stream?: string; section?: string; academicYear?: string } | null = null;
      if (database && cleanUid) {
        schoolLookups.push(
          get(ref(database, 'teacherSignups/' + cleanUid))
            .then(signupSnap => {
              if (signupSnap.exists()) {
                const val = signupSnap.val();
                if (val) {
                  signupClassMeta = {
                    className: val.assignedClass || val.className,
                    standard: val.standard,
                    stream: val.stream,
                    section: val.section,
                    academicYear: val.academicYear
                  };
                }
              }
            })
            .catch(() => null)
        );
      }

      await Promise.allSettled(schoolLookups);

      // 3. Merge retrieved cloud classes into local classes with deduplication
      const localClasses = StorageService.getClassesList();
      const allClassMap = new Map<string, ClassItem>();

      // Load existing local classes first
      localClasses.forEach(c => {
        if (c && c.id) allClassMap.set(c.id, c);
      });

      // Merge retrieved classes
      retrievedClasses.forEach(rc => {
        if (!rc || !rc.id) return;
        if (!allClassMap.has(rc.id)) {
          allClassMap.set(rc.id, rc);
        } else {
          const existing = allClassMap.get(rc.id)!;
          allClassMap.set(rc.id, {
            ...existing,
            ...rc,
            id: rc.id,
            teacherUid: rc.teacherUid || existing.teacherUid || cleanUid,
            teacherId: rc.teacherId || existing.teacherId || cleanUid,
            createdAt: existing.createdAt || rc.createdAt
          });
        }
      });

      // Restore students if cloud had them and local has none
      Object.entries(retrievedStudentsMap).forEach(([cid, studs]) => {
        const localStuds = StorageService.getStudents(cid);
        if (localStuds.length === 0 && studs.length > 0) {
          StorageService.saveStudents(studs, cid);
          const c = allClassMap.get(cid);
          if (c) {
            c.classStrength = studs.length;
          }
        }
      });

      // Partition classes into this teacher's classes and others
      const mergedList = Array.from(allClassMap.values());
      const teacherClassesList: ClassItem[] = [];
      const otherClassesList: ClassItem[] = [];

      mergedList.forEach(c => {
        const cUid = c.teacherUid || c.teacherId || c.createdByTeacherId || '';
        const cEmail = (c.createdByTeacherEmail || '').trim().toLowerCase();
        const isTeacherOwner = (
          (cleanUid && cUid === cleanUid) ||
          (cleanEmail && cEmail === cleanEmail) ||
          Boolean(foundBundle?.classesCatalog?.some(bc => bc.id === c.id)) ||
          (mergedList.length === 1 && !cUid && !cEmail)
        );

        if (isTeacherOwner) {
          c.teacherUid = cleanUid || c.teacherUid;
          c.teacherId = cleanUid || c.teacherId;
          c.createdByTeacherEmail = cleanEmail || c.createdByTeacherEmail;
          teacherClassesList.push(c);
        } else {
          otherClassesList.push(c);
        }
      });

      // Deduplicate teacherClassesList by normalized standard + section + stream
      const dedupedTeacherClasses: ClassItem[] = [];
      const seenTeacherClassKeys = new Set<string>();

      // Sort by creation date ascending (original class first)
      teacherClassesList.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

      for (const tc of teacherClassesList) {
        const key = `${(tc.standard || '').trim().toLowerCase()}::${(tc.section || '').trim().toLowerCase()}::${(tc.stream || '').trim().toLowerCase()}`;
        if (!seenTeacherClassKeys.has(key)) {
          seenTeacherClassKeys.add(key);
          dedupedTeacherClasses.push(tc);
        } else {
          // If a duplicate copy existed, preserve students/data
          const canonical = dedupedTeacherClasses.find(c =>
            `${(c.standard || '').trim().toLowerCase()}::${(c.section || '').trim().toLowerCase()}::${(c.stream || '').trim().toLowerCase()}` === key
          );
          if (canonical) {
            const canonicalStuds = StorageService.getStudents(canonical.id);
            const dupStuds = StorageService.getStudents(tc.id);
            if (canonicalStuds.length === 0 && dupStuds.length > 0) {
              StorageService.saveStudents(dupStuds, canonical.id);
              canonical.classStrength = dupStuds.length;
            }
          }
        }
      }

      // If no teacher classes found yet, but signup metadata existed, create and associate the original classroom
      if (dedupedTeacherClasses.length === 0 && signupClassMeta && signupClassMeta.standard && signupClassMeta.section) {
        const fallbackClassId = `class-${cleanUid.substring(0, 8) || Date.now()}`;
        const newClass: ClassItem = {
          id: fallbackClassId,
          className: signupClassMeta.className || `${signupClassMeta.standard} ${signupClassMeta.stream || ''} ${signupClassMeta.section}`.trim(),
          standard: signupClassMeta.standard,
          stream: signupClassMeta.stream || '',
          section: signupClassMeta.section,
          academicYear: signupClassMeta.academicYear || '2026-2027',
          classStrength: 0,
          teacherId: cleanUid,
          teacherUid: cleanUid,
          teacherName: '',
          schoolCode: cleanSchool,
          isTeacherCreated: true,
          createdByTeacherId: cleanUid,
          createdByTeacherEmail: cleanEmail,
          createdAt: new Date().toISOString()
        };
        dedupedTeacherClasses.push(newClass);
        StorageService.addNewClass(newClass, []);
        this.saveClassToSchool(cleanSchool, newClass, []).catch(() => {});
      }

      // If still empty but other classes exist and only 1 exists, adopt it
      if (dedupedTeacherClasses.length === 0 && otherClassesList.length === 1) {
        const singleClass = otherClassesList.shift()!;
        singleClass.teacherUid = cleanUid;
        singleClass.teacherId = cleanUid;
        singleClass.createdByTeacherEmail = cleanEmail;
        dedupedTeacherClasses.push(singleClass);
      }

      // Combine back with other classes
      const finalAllClasses = [...otherClassesList, ...dedupedTeacherClasses];
      StorageService.saveClassesList(finalAllClasses);

      // Select the primary classroom for this teacher
      const primaryClass = dedupedTeacherClasses[0];
      if (primaryClass) {
        StorageService.setActiveClassId(primaryClass.id);
        StorageService.saveClassInfo({
          id: primaryClass.id,
          standard: primaryClass.standard,
          stream: primaryClass.stream,
          section: primaryClass.section,
          className: primaryClass.className,
          academicYear: primaryClass.academicYear,
          classStrength: primaryClass.classStrength
        }, primaryClass.id);

        return {
          success: true,
          activeClassId: primaryClass.id,
          classItem: primaryClass,
          classes: dedupedTeacherClasses
        };
      }

      return {
        success: false,
        activeClassId: StorageService.getActiveClassId(cleanUid, cleanEmail),
        classes: dedupedTeacherClasses
      };
    } catch (err) {
      console.warn('restoreTeacherClassroom error:', err);
      const localClasses = StorageService.getClassesList();
      return { success: false, classes: localClasses };
    }
  }

  /**
   * Saves entered Gmail, date of birth, UID, schoolCode, and credential protection status
   * into Firebase RTDB and Firestore under:
   *  - 'gmail/{safeKey}' (separate global Gmail directory across the entire app)
   *  - 'schools/{cleanCode}/gmail/{safeKey}' (school-partitioned Gmail directory)
   *  - 'teacher_credentials/{safeKey}' / 'admin_credentials/{safeKey}'
   * Zero plaintext passwords are ever written to Firestore.
   */
  public async recordGmailEntry(
    gmail: string,
    metadata: {
      role?: 'teacher' | 'admin' | string;
      name?: string;
      schoolCode?: string;
      schoolName?: string;
      loginMethod?: 'email' | 'google' | string;
      password?: string;
      dob?: string;
      dateOfBirth?: string;
      teacherId?: string;
      uid?: string;
      phone?: string;
      subject?: string;
      assignedClass?: string;
      designation?: string;
    } = {}
  ): Promise<void> {
    if (!gmail) return;
    const resolvedUid = metadata.uid || metadata.teacherId || auth?.currentUser?.uid || '';
    if (!resolvedUid) return;

    try {
      const cleanEmail = gmail.trim().toLowerCase();
      if (!cleanEmail.includes('@')) return;
      const safeKey = this.sanitizeEmailKey(cleanEmail);
      const now = new Date().toISOString();
      const dobValue = (metadata.dob || metadata.dateOfBirth || '').trim();
      const cleanCode = this.sanitizeSchoolCode(metadata.schoolCode);
      const isGoogle = metadata.loginMethod === 'google';
      const payload: Record<string, any> = {
        uid: resolvedUid,
        teacherId: resolvedUid,
        gmail: cleanEmail,
        email: cleanEmail,
        role: metadata.role || 'teacher',
        name: (metadata.name || '').slice(0, 150),
        schoolCode: cleanCode,
        schoolName: (metadata.schoolName || '').slice(0, 200),
        loginMethod: metadata.loginMethod || 'email',
        authProvider: isGoogle ? 'google' : 'email_password',
        passwordProtected: true,
        credentialStatus: isGoogle ? 'Google OAuth Protected' : 'Firebase Auth Protected',
        lastEntryAt: now,
        updatedAt: now
      };
      if (dobValue) {
        payload.dob = dobValue.slice(0, 32);
        payload.dateOfBirth = dobValue.slice(0, 32);
      }
      if (metadata.phone) payload.phone = String(metadata.phone).slice(0, 40);
      if (metadata.subject) payload.subject = String(metadata.subject).slice(0, 100);
      if (metadata.assignedClass) payload.assignedClass = String(metadata.assignedClass).slice(0, 150);
      if (metadata.designation) payload.designation = String(metadata.designation).slice(0, 100);

      const credCollection = payload.role === 'admin' ? 'admin_credentials' : 'teacher_credentials';

      const ops: Promise<any>[] = [];
      if (database) {
        ops.push(update(ref(database, `gmail/${safeKey}`), payload).catch(() => {}));
        ops.push(update(ref(database, `schools/${cleanCode}/gmail/${safeKey}`), payload).catch(() => {}));
        ops.push(update(ref(database, `${credCollection}/${safeKey}`), payload).catch(() => {}));
      }
      if (firestore) {
        ops.push(fsSetDoc(fsDoc(firestore, 'gmail', safeKey), payload, { merge: true }));
        ops.push(fsSetDoc(fsDoc(firestore, credCollection, safeKey), payload, { merge: true }));
        ops.push(
          fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/gmail/${safeKey}`), payload, { merge: true }).catch(e =>
            console.warn('Firestore school gmail directory note:', e)
          )
        );
      }
      await Promise.allSettled(ops);
    } catch (e) {
      console.warn('recordGmailEntry note:', e);
    }
  }

  /**
   * Provisions and replicates the full HSS ALL IN ONE Firestore structure under
   * `/schools/{cleanCode}/...` whenever a user signs up, signs in, or updates School Code.
   * Existing data under SSHSS@111213 remains completely intact; new schoolCodes receive an
   * isolated, identically structured tenant tree.
   */
  public async provisionSchoolSpace(
    schoolCode: string,
    options: {
      schoolProfile?: Partial<SchoolProfile>;
      teacher?: TeacherAccount | null;
      admin?: SchoolAdminAccount | null;
      includeUserData?: boolean;
      reason?: string;
    } = {}
  ): Promise<boolean> {
    const currentUser = auth?.currentUser;
    if (!currentUser) return false;

    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const uid = currentUser.uid;
    const session = StorageService.getAuthSession();
    const localSchool = StorageService.getSchoolProfile();
    const localTeacherInfo = StorageService.getTeacherInfo();
    const nowIso = new Date().toISOString();

    const activeTeacher = options.teacher !== undefined ? options.teacher : session.currentTeacher;
    const activeAdmin = options.admin !== undefined ? options.admin : session.currentAdmin;
    const isAdminUser = Boolean(activeAdmin || session.role === 'admin');
    const cleanEmail = (
      activeTeacher?.email ||
      activeTeacher?.gmail ||
      activeAdmin?.email ||
      currentUser.email ||
      localTeacherInfo.email ||
      ''
    )
      .trim()
      .toLowerCase();

    const schoolName = (
      options.schoolProfile?.schoolName ||
      activeTeacher?.schoolName ||
      activeAdmin?.schoolName ||
      localSchool.schoolName ||
      "St. Sebastian's Higher Secondary School"
    )
      .trim()
      .slice(0, 200);

    const displayName = (
      activeAdmin?.adminName ||
      activeTeacher?.name ||
      localTeacherInfo.teacherName ||
      currentUser.displayName ||
      'Teacher'
    )
      .trim()
      .slice(0, 150);

    const updatedSchoolProfile: SchoolProfile = {
      ...localSchool,
      ...(options.schoolProfile || {}),
      schoolName,
      schoolCode: cleanCode
    };

    const sanitizedTeacher: TeacherAccount | null = activeTeacher
      ? {
          ...(this.sanitizeForFirestore(activeTeacher) as TeacherAccount),
          id: uid,
          uid,
          email: cleanEmail,
          gmail: cleanEmail,
          schoolName,
          schoolCode: cleanCode,
          lastActiveAt: nowIso
        }
      : null;

    const sanitizedAdmin: SchoolAdminAccount | null = activeAdmin
      ? {
          ...(this.sanitizeForFirestore(activeAdmin) as SchoolAdminAccount),
          id: uid,
          email: cleanEmail,
          schoolName,
          schoolCode: cleanCode
        }
      : null;

    if (firestore) {
      // 1. Update /users/{uid}.schoolCode FIRST so Firestore tenant security rule `isUserInSchool(cleanCode)` passes
      const userDocRef = fsDoc(firestore, 'users', uid);
      let existingRole = isAdminUser ? 'admin' : 'teacher';
      try {
        const snap = await fsGetDoc(userDocRef).catch(() => null);
        if (snap && snap.exists()) {
          const r = snap.data()?.role;
          if (r === 'admin' || r === 'schoolAdmin') existingRole = r;
        }
      } catch {}

      const userPayload: Record<string, any> = {
        userId: uid,
        uid,
        email: cleanEmail,
        gmail: cleanEmail,
        role: existingRole,
        schoolCode: cleanCode,
        schoolName,
        displayName,
        name: displayName,
        phone: String(activeTeacher?.phone || activeAdmin?.phone || localTeacherInfo.phone || '').slice(0, 40),
        dob: String(activeTeacher?.dob || activeAdmin?.dob || '').slice(0, 32),
        status: 'active',
        updatedAt: nowIso
      };
      if (sanitizedTeacher) userPayload.teacherAccount = sanitizedTeacher;
      if (sanitizedAdmin) userPayload.adminAccount = sanitizedAdmin;

      try {
        await fsSetDoc(userDocRef, userPayload, { merge: true });
      } catch (err) {
        console.warn('[CloudSync] provisionSchoolSpace /users write warning:', err);
        return false;
      }

      // 2. Create /schools/{cleanCode} root + schoolProfile/info
      const rootOps: Promise<any>[] = [
        fsSetDoc(
          fsDoc(firestore, `schools/${cleanCode}`),
          { schoolCode: cleanCode, schoolName, updatedAt: nowIso },
          { merge: true }
        ),
        fsSetDoc(
          fsDoc(firestore, `schools/${cleanCode}/schoolProfile/info`),
          {
            schoolName,
            schoolCode: cleanCode,
            schoolAddress: updatedSchoolProfile.schoolAddress || '',
            schoolPhone: updatedSchoolProfile.schoolPhone || '',
            schoolEmail: updatedSchoolProfile.schoolEmail || cleanEmail || '',
            principalName: updatedSchoolProfile.principalName || '',
            principalPhone: updatedSchoolProfile.principalPhone || ''
          },
          { merge: true }
        )
      ];
      await Promise.allSettled(rootOps);
    }

    // 3. Replicate teacher / gmail / email directory records inside /schools/{cleanCode}/...
    const bgOps: Promise<any>[] = [];
    if (sanitizedTeacher) {
      bgOps.push(this.saveTeacherToSchool(cleanCode, sanitizedTeacher).catch(() => false));
    }
    if (cleanEmail) {
      const authMethod = currentUser.providerData?.some(p => p.providerId === 'google.com') ? 'google' : 'email';
      bgOps.push(
        this.recordGmailEntry(cleanEmail, {
          role: isAdminUser ? 'admin' : 'teacher',
          name: displayName,
          schoolCode: cleanCode,
          schoolName,
          loginMethod: authMethod,
          dob: activeTeacher?.dob || activeAdmin?.dob || '',
          teacherId: uid,
          uid,
          phone: activeTeacher?.phone || activeAdmin?.phone || localTeacherInfo.phone || '',
          subject: activeTeacher?.subject || activeTeacher?.primarySubject || '',
          assignedClass: activeTeacher?.assignedClass || '',
          designation: activeTeacher?.designation || activeAdmin?.designation || localTeacherInfo.designation || ''
        }).catch(() => {})
      );
    }

    // 4. Replicate full classroom, student, attendance, exam, timetable, timetablePrefs, and reminder tree
    if (options.includeUserData !== false) {
      const bundle = this.gatherAllLocalData();
      const targetClasses = (bundle.classesCatalog || []).filter(c => {
        if (!c || !c.id) return false;
        const cUid = c.teacherUid || c.teacherId || c.createdByTeacherId || '';
        const cEmail = (c.createdByTeacherEmail || '').trim().toLowerCase();
        return !cUid || cUid === uid || (cleanEmail && cEmail === cleanEmail) || bundle.classesCatalog.length === 1;
      });

      for (const cls of targetClasses) {
        const scoped = bundle.classData?.[cls.id];
        const clsStudents = scoped?.students || [];
        const clsAttendance = scoped?.attendance || [];
        const clsExams = scoped?.exams || [];
        const clsMarksMap = scoped?.examMarksMap || {};

        const updatedCls: ClassItem = {
          ...cls,
          schoolCode: cleanCode,
          teacherId: cls.teacherId || uid,
          teacherUid: cls.teacherUid || uid,
          createdByTeacherId: cls.createdByTeacherId || uid,
          createdByTeacherEmail: cls.createdByTeacherEmail || cleanEmail
        };

        bgOps.push(this.saveClassToSchool(cleanCode, updatedCls, clsStudents).catch(() => false));
        for (const s of clsStudents) {
          if (s && s.id) {
            bgOps.push(this.saveStudentToSchool(cleanCode, s, cls.id).catch(() => false));
          }
        }
        for (const att of clsAttendance) {
          if (att && att.id) {
            bgOps.push(this.saveAttendanceToSchool(cleanCode, cls.id, att).catch(() => false));
          }
        }
        for (const ex of clsExams) {
          if (ex && ex.id) {
            bgOps.push(this.saveExamToSchool(cleanCode, cls.id, ex).catch(() => false));
          }
        }
        for (const [exId, markRec] of Object.entries(clsMarksMap)) {
          if (exId && markRec) {
            bgOps.push(
              this.saveExamMarksToSchool(cleanCode, cls.id, { ...markRec, examId: markRec.examId || exId }).catch(() => false)
            );
          }
        }
      }

      const slots = StorageService.getTimetables();
      const teacherSlots = slots.filter(s => s && (!s.teacherId || s.teacherId === uid));
      if (teacherSlots.length > 0) {
        for (const slot of teacherSlots) {
          bgOps.push(this.saveTimetableSlotToSchool(cleanCode, { ...slot, schoolCode: cleanCode }).catch(() => false));
        }
      }

      const timings = StorageService.getPeriodTimings(cleanCode, uid);
      const includeSat = StorageService.isSaturdayIncluded(cleanCode, uid);
      bgOps.push(
        this.saveTimetablePrefsToSchool(cleanCode, {
          includeSaturday: includeSat,
          periodTimings: timings
        }).catch(() => false)
      );

      if (bundle.reminders && bundle.reminders.length > 0) {
        bgOps.push(this.saveRemindersToSchool(cleanCode, bundle.reminders).catch(() => false));
      }
    }

    bgOps.push(
      this.recordTeacherActivity(cleanCode, {
        teacherId: uid,
        teacherName: displayName,
        subject: activeTeacher?.subject || activeTeacher?.primarySubject || 'General',
        assignedClass: activeTeacher?.assignedClass || '',
        activityType: 'profile_updated',
        description: options.reason || `Provisioned school space under ${cleanCode}`
      }).catch(() => {})
    );

    await Promise.race([
      Promise.allSettled(bgOps),
      new Promise(resolve => setTimeout(resolve, 3500))
    ]);

    return true;
  }

  /**
   * Lists all registered School Codes across Firestore (`schools`, `teachers`, `gmail`), RTDB, and local cache.
   * Allows authorized School Admins to switch between school workspaces cleanly.
   */
  public async fetchRegisteredSchoolCodes(): Promise<string[]> {
    const codeSet = new Set<string>(['SSHSS@111213']);
    const addCode = (raw?: string) => {
      const normalized = this.sanitizeSchoolCode(raw, '');
      if (normalized && /^[A-Z0-9_\-.@]+$/.test(normalized) && normalized.length <= 64) {
        codeSet.add(normalized);
      }
    };

    try {
      const localProfile = StorageService.getSchoolProfile();
      addCode(localProfile.schoolCode);
      StorageService.getTeacherAccounts().forEach(t => addCode(t?.schoolCode));
      StorageService.getClassesList().forEach(c => addCode(c?.schoolCode));
    } catch {}

    const lookups: Promise<any>[] = [];
    if (firestore) {
      lookups.push(
        fsGetDocs(fsCollection(firestore, 'schools'))
          .then(snap => {
            snap.forEach((d: any) => {
              addCode(d.data()?.schoolCode || d.id);
            });
          })
          .catch(() => {})
      );
      lookups.push(
        fsGetDocs(fsCollection(firestore, 'gmail'))
          .then(snap => {
            snap.forEach((d: any) => {
              addCode(d.data()?.schoolCode);
            });
          })
          .catch(() => {})
      );
      lookups.push(
        fsGetDocs(fsCollection(firestore, 'teachers'))
          .then(snap => {
            snap.forEach((d: any) => {
              addCode(d.data()?.schoolCode);
            });
          })
          .catch(() => {})
      );
    }
    if (database) {
      lookups.push(
        get(ref(database, 'schools'))
          .then(snap => {
            if (snap.exists()) {
              snap.forEach(child => {
                addCode(child.key || undefined);
              });
            }
          })
          .catch(() => {})
      );
    }

    await Promise.race([
      Promise.allSettled(lookups),
      new Promise<void>(resolve => setTimeout(resolve, 2500))
    ]);

    const sorted = Array.from(codeSet).sort((a, b) => {
      if (a === 'SSHSS@111213') return -1;
      if (b === 'SSHSS@111213') return 1;
      return a.localeCompare(b);
    });
    return sorted;
  }

  /**
   * Compatibility alias that records entered Gmail, DOB, and schoolCode (zero plaintext passwords).
   */
  public async storeCredentials(
    gmail: string,
    _password?: string,
    role: string = 'teacher',
    schoolCode?: string,
    dob?: string,
    name?: string,
    uid?: string
  ): Promise<void> {
    await this.recordGmailEntry(gmail, { role, schoolCode, dob, name, uid });
  }

  public async recordTeacherActivity(
    schoolCode: string,
    activity: {
      teacherId: string;
      teacherName: string;
      subject?: string;
      assignedClass?: string;
      activityType: TeacherActivityItem['activityType'];
      description: string;
    }
  ): Promise<void> {
    if (!schoolCode) return;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const actId = `act-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();

    const activityItem: TeacherActivityItem = {
      id: actId,
      schoolCode: cleanCode,
      teacherId: activity.teacherId,
      teacherName: activity.teacherName,
      subject: activity.subject,
      assignedClass: activity.assignedClass,
      activityType: activity.activityType,
      description: activity.description,
      timestamp: now
    };

    if (database) {
      try {
        const actRefPath = ref(database, `schools/${cleanCode}/activities/${actId}`);
        await set(actRefPath, activityItem).catch(() => {});

        if (activity.teacherId) {
          const teacherRefPath = ref(database, `schools/${cleanCode}/teachers/${activity.teacherId}`);
          await update(teacherRefPath, {
            lastActiveAt: now,
            recentActivity: activity.description
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('Error logging real-time teacher activity to RTDB:', e);
      }
    }

    if (firestore) {
      try {
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/activities/${actId}`), activityItem, { merge: true }).catch(() => {});
        if (activity.teacherId) {
          await fsSetDoc(
            fsDoc(firestore, `schools/${cleanCode}/teachers/${activity.teacherId}`),
            { lastActiveAt: now, recentActivity: activity.description },
            { merge: true }
          ).catch(() => {});
        }
      } catch (e) {
        console.warn('Error logging real-time teacher activity to Firestore:', e);
      }
    }
  }

  public listenToSchoolTeachers(
    schoolCode: string,
    onTeachersUpdated: (teachers: TeacherAccount[]) => void
  ): () => void {
    if (!schoolCode) return () => {};
    const cleanCode = this.sanitizeSchoolCode(schoolCode);

    if (this.unsubscribeSchoolTeachersSnapshot) {
      try {
        this.unsubscribeSchoolTeachersSnapshot();
      } catch (e) {}
      this.unsubscribeSchoolTeachersSnapshot = null;
    }

    const rtdbTeachersMap = new Map<string, TeacherAccount>();
    const fsSchoolTeachersMap = new Map<string, TeacherAccount>();
    const fsSchoolSignupsMap = new Map<string, TeacherAccount>();
    const fsRootTeachersMap = new Map<string, TeacherAccount>();
    const fsCredsTeachersMap = new Map<string, TeacherAccount>();

    const normalizeRecord = (raw: any, fallbackId?: string): TeacherAccount | null => {
      if (
        !raw ||
        raw.status === 'deleted' ||
        raw.status === 'permanently_deleted' ||
        raw.status === 'temporary_deleted' ||
        raw.temporarilyDeleted ||
        raw.permanentlyDeleted
      ) {
        return null;
      }
      const key = String(raw.teacherId || raw.uid || raw.id || fallbackId || raw.email || raw.gmail || '').trim();
      if (!key) return null;
      const email = String(raw.email || raw.gmail || '').trim().toLowerCase();
      const name = String(raw.name || raw.fullName || '').trim();
      if (!name && !email) return null;

      StorageService.removeTemporarilyDeletedTeacherId(key, email);
      StorageService.removePermanentlyDeletedTeacherId(key, email);

      return {
        ...raw,
        id: key,
        uid: key,
        name: name || 'Teacher',
        email,
        gmail: email,
        dob: raw.dob || raw.dateOfBirth || '',
        phone: raw.phone || raw.mobileNumber || '',
        schoolCode: this.sanitizeSchoolCode(raw.schoolCode || cleanCode, cleanCode),
        status: 'active'
      };
    };

    const emitMergedTeachers = () => {
      const mergedById = new Map<string, TeacherAccount>();
      const emailToId = new Map<string, string>();

      const upsert = (rec: TeacherAccount) => {
        const cleanEmail = (rec.email || rec.gmail || '').trim().toLowerCase();
        const existingId = (cleanEmail && emailToId.get(cleanEmail)) || (mergedById.has(rec.id) ? rec.id : '');
        if (existingId && mergedById.has(existingId)) {
          const prev = mergedById.get(existingId)!;
          mergedById.set(existingId, {
            ...prev,
            ...rec,
            id: existingId,
            uid: rec.uid || prev.uid || existingId,
            name: rec.name || prev.name,
            email: cleanEmail || prev.email,
            gmail: cleanEmail || prev.gmail,
            dob: rec.dob || prev.dob || '',
            phone: rec.phone || prev.phone || '',
            photoUrl: rec.photoUrl || prev.photoUrl || '',
            avatar: rec.avatar || prev.avatar || '👨‍🏫',
            subject: rec.subject || rec.primarySubject || prev.subject || 'General',
            primarySubject: rec.primarySubject || rec.subject || prev.primarySubject || 'General',
            assignedClass: rec.assignedClass || prev.assignedClass || '',
            academicYear: rec.academicYear || prev.academicYear || '',
            status: 'active'
          });
        } else {
          mergedById.set(rec.id, rec);
          if (cleanEmail) {
            emailToId.set(cleanEmail, rec.id);
          }
        }
      };

      // Merge all sources (RTDB + Firestore school subcollections + Firestore root collections)
      rtdbTeachersMap.forEach(upsert);
      fsCredsTeachersMap.forEach(upsert);
      fsRootTeachersMap.forEach(upsert);
      fsSchoolSignupsMap.forEach(upsert);
      fsSchoolTeachersMap.forEach(upsert);

      const mergedList = Array.from(mergedById.values());
      const localTeachers = StorageService.getTeacherAccounts();

      // Preserve any locally known fields not yet in cloud
      mergedList.forEach(rt => {
        const loc = localTeachers.find(lt =>
          lt.id === rt.id ||
          (rt.uid && (lt.uid === rt.uid || lt.id === rt.uid)) ||
          (rt.email && ((lt.email && lt.email.toLowerCase() === rt.email.toLowerCase()) || (lt.gmail && lt.gmail.toLowerCase() === rt.email.toLowerCase())))
        );
        if (loc) {
          if (!rt.dob && loc.dob) rt.dob = loc.dob;
          if (!rt.phone && loc.phone) rt.phone = loc.phone;
          if (!rt.photoUrl && loc.photoUrl) rt.photoUrl = loc.photoUrl;
          if (!rt.avatar && loc.avatar) rt.avatar = loc.avatar;
        }
      });

      const otherSchoolTeachers = localTeachers.filter(lt => this.sanitizeSchoolCode(lt.schoolCode, '') !== cleanCode);
      StorageService.saveTeacherAccounts([...otherSchoolTeachers, ...mergedList]);
      onTeachersUpdated(mergedList);
    };

    if (database) {
      try {
        const teachersRefPath = ref(database, `schools/${cleanCode}/teachers`);
        this.unsubscribeSchoolTeachersSnapshot = onValue(
          teachersRefPath,
          async snapshot => {
            rtdbTeachersMap.clear();
            if (snapshot.exists()) {
              snapshot.forEach(childSnap => {
                const norm = normalizeRecord(childSnap.val(), childSnap.key || undefined);
                if (norm) rtdbTeachersMap.set(norm.id, norm);
              });
            }

            try {
              const rootTeachersSnap = await get(ref(database, 'teachers')).catch(() => null);
              if (rootTeachersSnap && rootTeachersSnap.exists()) {
                rootTeachersSnap.forEach(child => {
                  const val = child.val();
                  if (val && val.schoolCode && this.sanitizeSchoolCode(val.schoolCode, '') === cleanCode) {
                    const norm = normalizeRecord(val, child.key || undefined);
                    if (norm) rtdbTeachersMap.set(norm.id, norm);
                  }
                });
              }
            } catch (e) {}

            emitMergedTeachers();
          },
          error => {
            console.warn('Error listening to school teachers in RTDB:', error);
          }
        );
      } catch (e) {
        console.warn('Could not establish real-time school teachers RTDB listener:', e);
      }
    }

    let unsubFsTeachers: (() => void) | null = null;
    let unsubFsSignups: (() => void) | null = null;
    let unsubFsRootTeachers: (() => void) | null = null;
    let unsubFsCreds: (() => void) | null = null;

    if (firestore) {
      try {
        const fsColRef = fsCollection(firestore, `schools/${cleanCode}/teachers`);
        unsubFsTeachers = fsOnSnapshot(fsColRef, (snapshot: any) => {
          if (snapshot) {
            fsSchoolTeachersMap.clear();
            snapshot.forEach((d: any) => {
              const norm = normalizeRecord(d.data(), d.id);
              if (norm) fsSchoolTeachersMap.set(norm.id, norm);
            });
            emitMergedTeachers();
          }
        }, (fsErr: any) => {
          console.warn('Firestore real-time teachers listener note:', fsErr);
        });

        const fsSignupsRef = fsCollection(firestore, `schools/${cleanCode}/teacherSignups`);
        unsubFsSignups = fsOnSnapshot(fsSignupsRef, (snapshot: any) => {
          if (snapshot) {
            fsSchoolSignupsMap.clear();
            snapshot.forEach((d: any) => {
              const norm = normalizeRecord(d.data(), d.id);
              if (norm) fsSchoolSignupsMap.set(norm.id, norm);
            });
            emitMergedTeachers();
          }
        }, (fsErr: any) => {
          console.warn('Firestore real-time school signups listener note:', fsErr);
        });

        const fsRootTeachersQuery = fsQuery(fsCollection(firestore, 'teachers'), fsWhere('schoolCode', '==', cleanCode));
        unsubFsRootTeachers = fsOnSnapshot(fsRootTeachersQuery, (snapshot: any) => {
          if (snapshot) {
            fsRootTeachersMap.clear();
            snapshot.forEach((d: any) => {
              const norm = normalizeRecord(d.data(), d.id);
              if (norm) fsRootTeachersMap.set(norm.id, norm);
            });
            emitMergedTeachers();
          }
        }, (fsErr: any) => {
          console.warn('Firestore real-time root teachers listener note:', fsErr);
        });

        const fsCredsQuery = fsQuery(fsCollection(firestore, 'teacher_credentials'), fsWhere('schoolCode', '==', cleanCode));
        unsubFsCreds = fsOnSnapshot(fsCredsQuery, (snapshot: any) => {
          if (snapshot) {
            fsCredsTeachersMap.clear();
            snapshot.forEach((d: any) => {
              const norm = normalizeRecord(d.data(), d.id);
              if (norm) fsCredsTeachersMap.set(norm.id, norm);
            });
            emitMergedTeachers();
          }
        }, (fsErr: any) => {
          console.warn('Firestore real-time credentials listener note:', fsErr);
        });
      } catch (e) {
        console.warn('Could not establish Firestore school teachers listeners:', e);
      }
    }

    return () => {
      if (this.unsubscribeSchoolTeachersSnapshot) {
        this.unsubscribeSchoolTeachersSnapshot();
        this.unsubscribeSchoolTeachersSnapshot = null;
      }
      if (unsubFsTeachers) unsubFsTeachers();
      if (unsubFsSignups) unsubFsSignups();
      if (unsubFsRootTeachers) unsubFsRootTeachers();
      if (unsubFsCreds) unsubFsCreds();
    };
  }

  public async clearSchoolActivities(schoolCode: string): Promise<boolean> {
    if (!schoolCode) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    try {
      if (database) {
        const activitiesRefPath = ref(database, `schools/${cleanCode}/activities`);
        await remove(activitiesRefPath).catch(() => {});
      }
      if (firestore) {
        const snap = await fsGetDocs(fsCollection(firestore, `schools/${cleanCode}/activities`));
        if (!snap.empty) {
          const batch = fsWriteBatch(firestore);
          snap.forEach((d: any) => batch.delete(d.ref));
          await batch.commit();
        }
      }
      return true;
    } catch (e) {
      console.error('Error clearing school activities:', e);
      return false;
    }
  }

  public listenToSchoolActivities(
    schoolCode: string,
    onActivitiesUpdated: (activities: TeacherActivityItem[]) => void
  ): () => void {
    if (!schoolCode) return () => {};
    const cleanCode = this.sanitizeSchoolCode(schoolCode);

    if (this.unsubscribeSchoolActivitiesSnapshot) {
      try {
        this.unsubscribeSchoolActivitiesSnapshot();
      } catch (e) {}
      this.unsubscribeSchoolActivitiesSnapshot = null;
    }

    const rtdbMap = new Map<string, TeacherActivityItem>();
    const fsMap = new Map<string, TeacherActivityItem>();

    const emitActivities = () => {
      const merged = new Map<string, TeacherActivityItem>();
      rtdbMap.forEach((v, k) => merged.set(k, v));
      fsMap.forEach((v, k) => merged.set(k, v));
      const list = Array.from(merged.values());
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      onActivitiesUpdated(list.slice(0, 40));
    };

    if (database) {
      try {
        const activitiesRefPath = ref(database, `schools/${cleanCode}/activities`);
        this.unsubscribeSchoolActivitiesSnapshot = onValue(
          activitiesRefPath,
          snapshot => {
            rtdbMap.clear();
            if (snapshot.exists()) {
              snapshot.forEach(childSnap => {
                const act = childSnap.val() as TeacherActivityItem;
                if (act && (act.id || childSnap.key)) {
                  const id = act.id || childSnap.key || '';
                  rtdbMap.set(id, { ...act, id });
                }
              });
            }
            emitActivities();
          },
          error => {
            console.warn('Error listening to school activities:', error);
          }
        );
      } catch (e) {
        console.warn('Could not establish real-time school activities listener:', e);
      }
    }

    let unsubFsAct: (() => void) | null = null;
    if (firestore) {
      try {
        const fsActRef = fsCollection(firestore, `schools/${cleanCode}/activities`);
        unsubFsAct = fsOnSnapshot(fsActRef, (snapshot: any) => {
          if (snapshot) {
            fsMap.clear();
            snapshot.forEach((d: any) => {
              const act = d.data() as TeacherActivityItem;
              if (act) {
                const id = act.id || d.id;
                fsMap.set(id, { ...act, id });
              }
            });
            emitActivities();
          }
        }, err => console.warn('Firestore listenToSchoolActivities warning:', err));
      } catch (e) {
        console.warn('Firestore listenToSchoolActivities setup error:', e);
      }
    }

    return () => {
      if (this.unsubscribeSchoolActivitiesSnapshot) {
        this.unsubscribeSchoolActivitiesSnapshot();
        this.unsubscribeSchoolActivitiesSnapshot = null;
      }
      if (unsubFsAct) unsubFsAct();
    };
  }

  // ------------------ SCHOOL BROADCASTS ------------------
  public async saveBroadcastToSchool(schoolCode: string, broadcast: PrincipalBroadcast): Promise<boolean> {
    if (!schoolCode || !broadcast || !broadcast.id) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanBroadcast: Record<string, any> = {
      id: broadcast.id,
      schoolCode: cleanCode,
      senderUid: auth?.currentUser?.uid || '',
      senderName: broadcast.senderName || 'Principal',
      title: broadcast.title,
      message: broadcast.message,
      priority: broadcast.priority || 'normal',
      category: broadcast.category || 'general',
      targetAudience: broadcast.targetAudience || 'All Teachers',
      date: broadcast.date || new Date().toISOString().split('T')[0],
      time: broadcast.time || '09:00',
      createdAt: broadcast.createdAt || new Date().toISOString()
    };

    if (database) {
      try {
        await set(ref(database, `schools/${cleanCode}/broadcasts/${broadcast.id}`), cleanBroadcast);
      } catch (e) {
        console.warn('RTDB saveBroadcastToSchool warning:', e);
      }
    }
    if (firestore) {
      try {
        await Promise.all([
          fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/broadcasts/${broadcast.id}`), cleanBroadcast, { merge: true }),
          fsSetDoc(fsDoc(firestore, `broadcasts/${broadcast.id}`), cleanBroadcast, { merge: true })
        ]);
      } catch (e) {
        console.error('Firestore saveBroadcastToSchool error:', e);
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/broadcasts/${broadcast.id}`);
      }
    }
    return true;
  }

  public async deleteBroadcastFromSchool(schoolCode: string, broadcastId: string): Promise<boolean> {
    if (!schoolCode || !broadcastId) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    if (database) {
      try {
        await remove(ref(database, `schools/${cleanCode}/broadcasts/${broadcastId}`));
      } catch (e) {
        console.warn('RTDB deleteBroadcastFromSchool warning:', e);
      }
    }
    if (firestore) {
      try {
        await Promise.all([
          fsDeleteDoc(fsDoc(firestore, `schools/${cleanCode}/broadcasts/${broadcastId}`)),
          fsDeleteDoc(fsDoc(firestore, `broadcasts/${broadcastId}`)).catch(() => {})
        ]);
      } catch (e) {
        console.error('Firestore deleteBroadcastFromSchool error:', e);
        handleFirestoreError(e, OperationType.DELETE, `schools/${cleanCode}/broadcasts/${broadcastId}`);
      }
    }
    return true;
  }

  public listenToSchoolBroadcasts(
    schoolCode: string,
    onBroadcastsUpdated: (broadcasts: PrincipalBroadcast[]) => void
  ): () => void {
    if (!schoolCode) return () => {};
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const fsMap = new Map<string, PrincipalBroadcast>();
    const rtdbMap = new Map<string, PrincipalBroadcast>();

    const emitBroadcasts = () => {
      const merged = new Map<string, PrincipalBroadcast>();
      rtdbMap.forEach((v, k) => merged.set(k, v));
      fsMap.forEach((v, k) => merged.set(k, v));
      const list = Array.from(merged.values());
      list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      StorageService.savePrincipalBroadcasts(list);
      onBroadcastsUpdated(list);
    };

    let unsubFs: (() => void) | null = null;
    if (firestore) {
      try {
        unsubFs = fsOnSnapshot(fsCollection(firestore, `schools/${cleanCode}/broadcasts`), (snapshot: any) => {
          fsMap.clear();
          snapshot.forEach((d: any) => {
            const b = d.data() as PrincipalBroadcast;
            if (b) fsMap.set(b.id || d.id, { ...b, id: b.id || d.id });
          });
          emitBroadcasts();
        }, err => console.warn('Firestore listenToSchoolBroadcasts warning:', err));
      } catch (e) {
        console.warn('Firestore listenToSchoolBroadcasts setup error:', e);
      }
    }

    let unsubRtdb: (() => void) | null = null;
    if (database) {
      try {
        const bRef = ref(database, `schools/${cleanCode}/broadcasts`);
        unsubRtdb = onValue(bRef, snapshot => {
          rtdbMap.clear();
          if (snapshot.exists()) {
            snapshot.forEach(child => {
              const b = child.val() as PrincipalBroadcast;
              if (b) rtdbMap.set(b.id || child.key || '', b);
            });
          }
          emitBroadcasts();
        });
      } catch (e) {}
    }
    return () => {
      if (unsubFs) unsubFs();
      if (unsubRtdb) unsubRtdb();
    };
  }

  // ------------------ SCHOOL TIMETABLES & PERIOD PREFS ------------------
  public async saveTimetableSlotToSchool(schoolCode: string, slot: TimetableSlot): Promise<boolean> {
    if (!schoolCode || !slot || !slot.id) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanSlot = this.sanitizeTimetablePayload(slot, cleanCode, auth?.currentUser?.uid);
    if (database) {
      try {
        await set(ref(database, `schools/${cleanCode}/timetables/${slot.id}`), cleanSlot);
      } catch (e) {
        console.warn('RTDB saveTimetableSlotToSchool warning:', e);
      }
    }
    if (firestore) {
      try {
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/timetables/${slot.id}`), cleanSlot, { merge: true });
      } catch (e) {
        console.error('Firestore saveTimetableSlotToSchool error:', e);
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/timetables/${slot.id}`);
      }
    }
    return true;
  }

  public async saveTimetablesToSchool(schoolCode: string, slots: TimetableSlot[]): Promise<boolean> {
    if (!schoolCode) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const uid = auth?.currentUser?.uid;

    if (database) {
      try {
        const timetablesMap: Record<string, any> = {};
        slots.forEach(s => {
          if (s.id) timetablesMap[s.id] = this.sanitizeTimetablePayload(s, cleanCode, uid);
        });
        await set(ref(database, `schools/${cleanCode}/timetables`), timetablesMap);
      } catch (e) {
        console.warn('RTDB saveTimetablesToSchool warning:', e);
      }
    }

    if (firestore) {
      try {
        const batch = fsWriteBatch(firestore);
        const existingSnap = await fsGetDocs(fsCollection(firestore, `schools/${cleanCode}/timetables`));
        const keepIds = new Set(slots.map(s => s.id).filter(Boolean));
        existingSnap.forEach((d: any) => {
          if (!keepIds.has(d.id)) {
            batch.delete(d.ref);
          }
        });
        slots.forEach(s => {
          if (s.id) {
            batch.set(
              fsDoc(firestore, `schools/${cleanCode}/timetables/${s.id}`),
              this.sanitizeTimetablePayload(s, cleanCode, uid),
              { merge: true }
            );
          }
        });
        await batch.commit();
      } catch (e) {
        console.error('Firestore saveTimetablesToSchool error:', e);
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/timetables`);
      }
    }
    return true;
  }

  public async deleteTimetableSlotFromSchool(schoolCode: string, slotId: string): Promise<boolean> {
    if (!schoolCode || !slotId) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    if (database) {
      try {
        await remove(ref(database, `schools/${cleanCode}/timetables/${slotId}`));
      } catch (e) {}
    }
    if (firestore) {
      try {
        await fsDeleteDoc(fsDoc(firestore, `schools/${cleanCode}/timetables/${slotId}`));
      } catch (e) {
        console.error('Firestore deleteTimetableSlotFromSchool error:', e);
        handleFirestoreError(e, OperationType.DELETE, `schools/${cleanCode}/timetables/${slotId}`);
      }
    }
    return true;
  }

  public async saveTimetablePrefsToSchool(
    schoolCode: string,
    prefs: { includeSaturday: boolean; periodTimings: any[] }
  ): Promise<boolean> {
    if (!schoolCode) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const uid = auth?.currentUser?.uid || '';
    const nowIso = new Date().toISOString();
    const payload = {
      ownerUid: uid,
      schoolCode: cleanCode,
      teacherId: uid,
      includeSaturday: Boolean(prefs.includeSaturday),
      periodTimings: Array.isArray(prefs.periodTimings) ? prefs.periodTimings.slice(0, 24) : [],
      prefs,
      updatedAt: nowIso
    };
    if (database) {
      try {
        await set(ref(database, `schools/${cleanCode}/timetablePrefs`), payload);
      } catch (e) {}
    }
    if (firestore) {
      try {
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/timetablePrefs/config`), payload, { merge: true });
      } catch (e) {
        console.error('Firestore saveTimetablePrefsToSchool error:', e);
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/timetablePrefs/config`);
      }
    }
    return true;
  }

  public listenToSchoolTimetables(
    schoolCode: string,
    onTimetablesUpdated: (slots: TimetableSlot[]) => void
  ): () => void {
    if (!schoolCode) return () => {};
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const fsMap = new Map<string, TimetableSlot>();
    const rtdbMap = new Map<string, TimetableSlot>();

    const emitTimetables = () => {
      const merged = new Map<string, TimetableSlot>();
      rtdbMap.forEach((v, k) => merged.set(k, v));
      fsMap.forEach((v, k) => merged.set(k, v));
      const list = Array.from(merged.values());
      StorageService.saveTimetables(list);
      onTimetablesUpdated(list);
    };

    let unsubFs: (() => void) | null = null;
    if (firestore) {
      try {
        unsubFs = fsOnSnapshot(fsCollection(firestore, `schools/${cleanCode}/timetables`), (snapshot: any) => {
          fsMap.clear();
          snapshot.forEach((d: any) => {
            const s = d.data() as TimetableSlot;
            if (s) fsMap.set(s.id || d.id, { ...s, id: s.id || d.id });
          });
          emitTimetables();
        }, err => console.warn('Firestore listenToSchoolTimetables warning:', err));
      } catch (e) {}
    }

    let unsubRtdb: (() => void) | null = null;
    if (database) {
      try {
        const tRef = ref(database, `schools/${cleanCode}/timetables`);
        unsubRtdb = onValue(tRef, snapshot => {
          rtdbMap.clear();
          if (snapshot.exists()) {
            snapshot.forEach(child => {
              const s = child.val() as TimetableSlot;
              if (s) rtdbMap.set(s.id || child.key || '', s);
            });
          }
          emitTimetables();
        });
      } catch (e) {}
    }
    return () => {
      if (unsubFs) unsubFs();
      if (unsubRtdb) unsubRtdb();
    };
  }

  // ------------------ SCHOOL STUDENTS ------------------
  public async saveStudentToSchool(schoolCode: string, student: Student, classIdOverride?: string): Promise<boolean> {
    if (!schoolCode || !student || !student.id) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const clsId = classIdOverride || student.classId || '';
    const cleanStudent = this.sanitizeStudentPayload(student, clsId, cleanCode, auth?.currentUser?.uid);

    if (database) {
      try {
        await set(ref(database, `schools/${cleanCode}/students/${student.id}`), cleanStudent);
        if (clsId) {
          await set(ref(database, `schools/${cleanCode}/classes/${clsId}/students/${student.id}`), cleanStudent);
        }
      } catch (e) {}
    }
    if (firestore) {
      try {
        const ops: Promise<any>[] = [
          fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/students/${student.id}`), cleanStudent, { merge: true })
        ];
        if (clsId) {
          ops.push(fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/classes/${clsId}/students/${student.id}`), cleanStudent, { merge: true }));
        }
        await Promise.all(ops);
      } catch (e) {
        console.error('Firestore saveStudentToSchool error:', e);
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/students/${student.id}`);
      }
    }
    return true;
  }

  public async deleteStudentFromSchool(schoolCode: string, studentId: string, classId?: string): Promise<boolean> {
    if (!schoolCode || !studentId) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    if (database) {
      try {
        await remove(ref(database, `schools/${cleanCode}/students/${studentId}`));
        if (classId) {
          await remove(ref(database, `schools/${cleanCode}/classes/${classId}/students/${studentId}`));
        }
      } catch (e) {}
    }
    if (firestore) {
      try {
        const ops: Promise<any>[] = [
          fsDeleteDoc(fsDoc(firestore, `schools/${cleanCode}/students/${studentId}`))
        ];
        if (classId) {
          ops.push(fsDeleteDoc(fsDoc(firestore, `schools/${cleanCode}/classes/${classId}/students/${studentId}`)));
        }
        await Promise.all(ops);
      } catch (e) {
        console.error('Firestore deleteStudentFromSchool error:', e);
        handleFirestoreError(e, OperationType.DELETE, `schools/${cleanCode}/students/${studentId}`);
      }
    }
    return true;
  }

  public listenToSchoolStudents(
    schoolCode: string,
    onStudentsUpdated: (students: Student[]) => void
  ): () => void {
    if (!schoolCode) return () => {};
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const fsMap = new Map<string, Student>();
    const rtdbMap = new Map<string, Student>();

    const emitStudents = () => {
      const merged = new Map<string, Student>();
      rtdbMap.forEach((v, k) => merged.set(k, v));
      fsMap.forEach((v, k) => merged.set(k, v));
      const list = Array.from(merged.values());
      StorageService.saveStudents(list);
      onStudentsUpdated(list);
    };

    let unsubFs: (() => void) | null = null;
    if (firestore) {
      try {
        unsubFs = fsOnSnapshot(fsCollection(firestore, `schools/${cleanCode}/students`), (snapshot: any) => {
          fsMap.clear();
          snapshot.forEach((d: any) => {
            const st = d.data() as Student;
            if (st) fsMap.set(st.id || d.id, { ...st, id: st.id || d.id });
          });
          emitStudents();
        }, err => console.warn('Firestore listenToSchoolStudents warning:', err));
      } catch (e) {}
    }

    let unsubRtdb: (() => void) | null = null;
    if (database) {
      try {
        const sRef = ref(database, `schools/${cleanCode}/students`);
        unsubRtdb = onValue(sRef, snapshot => {
          rtdbMap.clear();
          if (snapshot.exists()) {
            snapshot.forEach(child => {
              const st = child.val() as Student;
              if (st) rtdbMap.set(st.id || child.key || '', st);
            });
          }
          emitStudents();
        });
      } catch (e) {}
    }
    return () => {
      if (unsubFs) unsubFs();
      if (unsubRtdb) unsubRtdb();
    };
  }

  // ------------------ ATTENDANCE, EXAMS, MARKS & REMINDERS DIRECT FIRESTORE SYNC ------------------
  public async saveAttendanceToSchool(schoolCode: string, classId: string, record: AttendanceRecord): Promise<boolean> {
    if (!schoolCode || !classId || !record?.id) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanPayload = this.sanitizeAttendancePayload(record, classId, cleanCode, auth?.currentUser?.uid);
    if (database) {
      await set(ref(database, `schools/${cleanCode}/classes/${classId}/attendance/${record.id}`), cleanPayload).catch(() => {});
    }
    if (firestore) {
      try {
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/classes/${classId}/attendance/${record.id}`), cleanPayload, { merge: true });
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/classes/${classId}/attendance/${record.id}`);
      }
    }
    return true;
  }

  public async deleteAttendanceFromSchool(schoolCode: string, classId: string, recordId: string): Promise<boolean> {
    if (!schoolCode || !classId || !recordId) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    if (database) {
      await remove(ref(database, `schools/${cleanCode}/classes/${classId}/attendance/${recordId}`)).catch(() => {});
    }
    if (firestore) {
      try {
        await fsDeleteDoc(fsDoc(firestore, `schools/${cleanCode}/classes/${classId}/attendance/${recordId}`));
      } catch (e) {
        handleFirestoreError(e, OperationType.DELETE, `schools/${cleanCode}/classes/${classId}/attendance/${recordId}`);
      }
    }
    return true;
  }

  public async saveExamToSchool(schoolCode: string, classId: string, exam: Exam): Promise<boolean> {
    if (!schoolCode || !classId || !exam?.id) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanPayload = this.sanitizeExamPayload(exam, classId, cleanCode, auth?.currentUser?.uid);
    if (database) {
      await set(ref(database, `schools/${cleanCode}/classes/${classId}/exams/${exam.id}`), cleanPayload).catch(() => {});
    }
    if (firestore) {
      try {
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/classes/${classId}/exams/${exam.id}`), cleanPayload, { merge: true });
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/classes/${classId}/exams/${exam.id}`);
      }
    }
    return true;
  }

  public async deleteExamFromSchool(schoolCode: string, classId: string, examId: string): Promise<boolean> {
    if (!schoolCode || !classId || !examId) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    if (database) {
      await remove(ref(database, `schools/${cleanCode}/classes/${classId}/exams/${examId}`)).catch(() => {});
      await remove(ref(database, `schools/${cleanCode}/classes/${classId}/examMarks/${examId}`)).catch(() => {});
    }
    if (firestore) {
      try {
        await Promise.all([
          fsDeleteDoc(fsDoc(firestore, `schools/${cleanCode}/classes/${classId}/exams/${examId}`)),
          fsDeleteDoc(fsDoc(firestore, `schools/${cleanCode}/classes/${classId}/examMarks/${examId}`)).catch(() => {})
        ]);
      } catch (e) {
        handleFirestoreError(e, OperationType.DELETE, `schools/${cleanCode}/classes/${classId}/exams/${examId}`);
      }
    }
    return true;
  }

  public async saveExamMarksToSchool(schoolCode: string, classId: string, record: ExamMarksRecord): Promise<boolean> {
    if (!schoolCode || !classId || !record?.examId) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const uid = auth?.currentUser?.uid || '';
    const cleanPayload = {
      examId: record.examId,
      marks: record.marks || {},
      updatedAt: record.updatedAt || new Date().toISOString(),
      classId,
      teacherId: uid,
      teacherUid: uid,
      schoolCode: cleanCode
    };
    if (database) {
      await set(ref(database, `schools/${cleanCode}/classes/${classId}/examMarks/${record.examId}`), cleanPayload).catch(() => {});
    }
    if (firestore) {
      try {
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/classes/${classId}/examMarks/${record.examId}`), cleanPayload, { merge: true });
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/classes/${classId}/examMarks/${record.examId}`);
      }
    }
    return true;
  }

  public async saveRemindersToSchool(schoolCode: string, reminders: Reminder[]): Promise<boolean> {
    if (!schoolCode) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const uid = auth?.currentUser?.uid || '';
    if (firestore) {
      try {
        const batch = fsWriteBatch(firestore);
        const existingSnap = await fsGetDocs(fsCollection(firestore, `schools/${cleanCode}/reminders`));
        const keepIds = new Set(reminders.map(r => r.id).filter(Boolean));
        existingSnap.forEach((d: any) => {
          if (!keepIds.has(d.id)) {
            batch.delete(d.ref);
          }
        });
        reminders.forEach(r => {
          if (r.id) {
            batch.set(
              fsDoc(firestore, `schools/${cleanCode}/reminders/${r.id}`),
              this.sanitizeReminderPayload(r, cleanCode, uid),
              { merge: true }
            );
          }
        });
        await batch.commit();
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/reminders`);
      }
    }
    return true;
  }

  // ------------------ SCHOOL PROFILE ------------------
  public async saveSchoolProfileToSchool(schoolCode: string, profile: SchoolProfile): Promise<boolean> {
    if (!schoolCode || !profile) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanProfile: Record<string, any> = {
      schoolName: profile.schoolName || "St. Sebastian's Higher Secondary School",
      schoolCode: cleanCode,
      schoolAddress: profile.schoolAddress || '',
      schoolPhone: profile.schoolPhone || '',
      schoolEmail: profile.schoolEmail || '',
      principalName: profile.principalName || '',
      principalPhone: profile.principalPhone || ''
    };
    if (database) {
      try {
        await set(ref(database, `schools/${cleanCode}/schoolProfile`), cleanProfile);
      } catch (e) {}
    }
    if (firestore) {
      try {
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/schoolProfile/info`), cleanProfile, { merge: true });
      } catch (e) {
        console.error('Firestore saveSchoolProfileToSchool error:', e);
        handleFirestoreError(e, OperationType.WRITE, `schools/${cleanCode}/schoolProfile/info`);
      }
    }
    return true;
  }

  public listenToSchoolProfile(
    schoolCode: string,
    onProfileUpdated: (profile: SchoolProfile) => void
  ): () => void {
    if (!schoolCode) return () => {};
    const cleanCode = this.sanitizeSchoolCode(schoolCode);

    let unsubFs: (() => void) | null = null;
    if (firestore) {
      try {
        unsubFs = fsOnSnapshot(fsDoc(firestore, `schools/${cleanCode}/schoolProfile/info`), (snap: any) => {
          if (snap.exists()) {
            const prof = snap.data() as SchoolProfile;
            if (prof && prof.schoolName) {
              StorageService.saveSchoolProfile(prof);
              onProfileUpdated(prof);
            }
          }
        }, err => console.warn('Firestore listenToSchoolProfile warning:', err));
      } catch (e) {}
    }

    let unsubRtdb: (() => void) | null = null;
    if (database) {
      try {
        const pRef = ref(database, `schools/${cleanCode}/schoolProfile`);
        unsubRtdb = onValue(pRef, snapshot => {
          if (snapshot.exists()) {
            const prof = snapshot.val() as SchoolProfile;
            if (prof && prof.schoolName) {
              StorageService.saveSchoolProfile(prof);
              onProfileUpdated(prof);
            }
          }
        });
      } catch (e) {}
    }
    return () => {
      if (unsubFs) unsubFs();
      if (unsubRtdb) unsubRtdb();
    };
  }

  // ------------------ AUDIT LOGS ------------------
  public async saveAuditLogToSchool(schoolCode: string, logItem: AuditLogItem): Promise<boolean> {
    if (!schoolCode || !logItem || !logItem.id) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const cleanLog: Record<string, any> = {
      id: logItem.id,
      schoolCode: cleanCode,
      timestamp: logItem.timestamp || new Date().toISOString(),
      user: logItem.user || 'Administrator',
      role: logItem.role || 'SCHOOL_ADMIN',
      action: logItem.action || 'EVENT',
      target: logItem.target || '',
      details: (logItem.details || '').slice(0, 1000),
      status: ['SUCCESS', 'DENIED', 'INFO', 'WARNING', 'ERROR'].includes(logItem.status) ? logItem.status : 'INFO'
    };
    if (database) {
      try {
        await set(ref(database, `schools/${cleanCode}/auditLogs/${logItem.id}`), cleanLog);
      } catch (e) {}
    }
    if (firestore) {
      try {
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/auditLogs/${logItem.id}`), cleanLog, { merge: true });
      } catch (e) {
        console.warn('Firestore saveAuditLogToSchool warning:', e);
      }
    }
    return true;
  }

  public async clearAuditLogsFromSchool(schoolCode: string): Promise<boolean> {
    if (!schoolCode) return false;
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    if (database) {
      try {
        await remove(ref(database, `schools/${cleanCode}/auditLogs`));
      } catch (e) {}
    }
    if (firestore) {
      try {
        const snap = await fsGetDocs(fsCollection(firestore, `schools/${cleanCode}/auditLogs`));
        if (!snap.empty) {
          const batch = fsWriteBatch(firestore);
          snap.forEach((d: any) => batch.delete(d.ref));
          await batch.commit();
        }
      } catch (e) {
        console.warn('Firestore clearAuditLogsFromSchool warning:', e);
      }
    }
    return true;
  }

  public listenToSchoolAuditLogs(
    schoolCode: string,
    onAuditLogsUpdated: (logs: AuditLogItem[]) => void
  ): () => void {
    if (!schoolCode) return () => {};
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const fsMap = new Map<string, AuditLogItem>();
    const rtdbMap = new Map<string, AuditLogItem>();

    const emitLogs = () => {
      const merged = new Map<string, AuditLogItem>();
      rtdbMap.forEach((v, k) => merged.set(k, v));
      fsMap.forEach((v, k) => merged.set(k, v));
      const list = Array.from(merged.values());
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      StorageService.saveAuditLogs(list);
      onAuditLogsUpdated(list);
    };

    let unsubFs: (() => void) | null = null;
    if (firestore) {
      try {
        unsubFs = fsOnSnapshot(fsCollection(firestore, `schools/${cleanCode}/auditLogs`), (snapshot: any) => {
          fsMap.clear();
          snapshot.forEach((d: any) => {
            const item = d.data() as AuditLogItem;
            if (item) fsMap.set(item.id || d.id, { ...item, id: item.id || d.id });
          });
          emitLogs();
        }, err => console.warn('Firestore listenToSchoolAuditLogs warning:', err));
      } catch (e) {}
    }

    let unsubRtdb: (() => void) | null = null;
    if (database) {
      try {
        const aRef = ref(database, `schools/${cleanCode}/auditLogs`);
        unsubRtdb = onValue(aRef, snapshot => {
          rtdbMap.clear();
          if (snapshot.exists()) {
            snapshot.forEach(child => {
              const item = child.val() as AuditLogItem;
              if (item) rtdbMap.set(item.id || child.key || '', item);
            });
          }
          emitLogs();
        });
      } catch (e) {}
    }
    return () => {
      if (unsubFs) unsubFs();
      if (unsubRtdb) unsubRtdb();
    };
  }

  public async fetchSchoolTeachers(schoolCode: string): Promise<TeacherAccount[]> {
    if (!schoolCode) return [];
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const teachersMap = new Map<string, TeacherAccount>();

    if (database) {
      try {
        const teachersRefPath = ref(database, `schools/${cleanCode}/teachers`);
        const snap = await get(teachersRefPath);
        if (snap.exists()) {
          snap.forEach(childSnap => {
            const t = childSnap.val() as TeacherAccount;
            if (t && (t.id || childSnap.key)) {
              const id = t.id || childSnap.key || '';
              teachersMap.set(id, { ...t, id });
            }
          });
        }
      } catch (e) {
        console.warn('Error fetching school teachers from RTDB:', e);
      }
    }

    if (firestore) {
      try {
        const fsSnap = await fsGetDocs(fsCollection(firestore, `schools/${cleanCode}/teachers`)).catch(() => null);
        if (fsSnap) {
          fsSnap.forEach((d: any) => {
            const t = d.data() as TeacherAccount;
            if (t && (t.id || d.id)) {
              const id = t.id || d.id;
              if (!teachersMap.has(id)) teachersMap.set(id, { ...t, id });
            }
          });
        }
      } catch (e) {}
    }

    return Array.from(teachersMap.values());
  }

  public async fetchTeacherCredential(
    gmail: string,
    schoolCode?: string
  ): Promise<{
    found: boolean;
    valid: boolean;
    reason?: 'status_inactive' | 'school_mismatch' | 'not_found';
    teacher?: TeacherAccount;
  }> {
    if (!gmail || !gmail.trim()) return { found: false, valid: false, reason: 'not_found' };
    const cleanGmail = gmail.trim().toLowerCase();
    const cleanSchoolCode = schoolCode ? this.sanitizeSchoolCode(schoolCode, '') : '';

    // Fast local accounts check first (0ms)
    try {
      const localTeachers = StorageService.getTeacherAccounts();
      const localMatch = localTeachers.find(t => 
        (t.email && t.email.toLowerCase() === cleanGmail) || 
        (t.gmail && t.gmail.toLowerCase() === cleanGmail)
      );
      if (localMatch) {
        if (localMatch.status && localMatch.status !== 'active') {
          return { found: true, valid: false, reason: 'status_inactive', teacher: localMatch };
        }
        if (cleanSchoolCode && localMatch.schoolCode && localMatch.schoolCode.toUpperCase() !== cleanSchoolCode) {
          return { found: true, valid: false, reason: 'school_mismatch', teacher: localMatch };
        }
        return { found: true, valid: true, teacher: localMatch };
      }
    } catch (e) {}

    let matchedTeacher: TeacherAccount | null = null;
    const queries: Promise<any>[] = [];
    const emailKey = this.sanitizeEmailKey(cleanGmail);

    if (firestore) {
      // Check dedicated teacher_credentials/{emailKey}
      queries.push(
        fsGetDoc(fsDoc(firestore, 'teacher_credentials', emailKey))
          .then(snap => {
            if (snap.exists() && !matchedTeacher) {
              const val = snap.data() as any;
              if (val) {
                matchedTeacher = {
                  id: val.teacherId || val.uid || `teacher-${emailKey}`,
                  uid: val.uid || val.teacherId,
                  name: val.name || 'Teacher',
                  email: cleanGmail,
                  gmail: cleanGmail,
                  dob: val.dob || val.dateOfBirth || '',
                  phone: val.phone || '',
                  schoolName: val.schoolName || "St. Sebastian's Higher Secondary School",
                  schoolCode: val.schoolCode || cleanSchoolCode || 'SSHSS@111213',
                  subject: val.subject || 'General',
                  assignedClass: val.assignedClass || '',
                  designation: val.designation || 'Teacher',
                  status: 'active',
                  createdAt: val.createdAt || new Date().toISOString()
                };
              }
            }
          })
          .catch(() => null)
      );

      // Check Firestore email_accounts/{emailKey}
      queries.push(
        fsGetDoc(fsDoc(firestore, 'email_accounts', emailKey))
          .then(snap => {
            if (snap.exists() && !matchedTeacher) {
              const val = snap.data() as any;
              if (val?.teacherAccount) {
                matchedTeacher = val.teacherAccount;
              }
            }
          })
          .catch(() => null)
      );

      // Check Firestore teachers & teacherSignups
      queries.push(
        fsGetDocs(fsQuery(fsCollection(firestore, 'teachers'), fsWhere('email', '==', cleanGmail)))
          .then(querySnap => {
            if (!querySnap.empty && !matchedTeacher) {
              matchedTeacher = querySnap.docs[0].data() as TeacherAccount;
            }
          })
          .catch(() => null)
      );

      queries.push(
        fsGetDocs(fsQuery(fsCollection(firestore, 'teacherSignups'), fsWhere('email', '==', cleanGmail)))
          .then(querySnap => {
            if (!querySnap.empty && !matchedTeacher) {
              const val = querySnap.docs[0].data() as any;
              matchedTeacher = {
                ...val,
                id: val.id || val.uid || querySnap.docs[0].id,
                name: val.name || val.fullName || 'Teacher',
                email: cleanGmail,
                gmail: cleanGmail,
                dob: val.dob || val.dateOfBirth || ''
              };
            }
          })
          .catch(() => null)
      );

      if (cleanSchoolCode) {
        queries.push(
          fsGetDocs(fsQuery(fsCollection(firestore, `schools/${cleanSchoolCode}/teachers`), fsWhere('email', '==', cleanGmail)))
            .then(querySnap => {
              if (!querySnap.empty && !matchedTeacher) {
                matchedTeacher = querySnap.docs[0].data() as TeacherAccount;
              }
            })
            .catch(() => null)
        );
      }

      queries.push(
        fsGetDocs(fsQuery(fsCollection(firestore, 'users'), fsWhere('email', '==', cleanGmail)))
          .then(querySnap => {
            if (!querySnap.empty && !matchedTeacher) {
              const docData = querySnap.docs[0].data();
              if (docData?.teacherAccount) {
                matchedTeacher = docData.teacherAccount;
              } else if (docData && docData.role === 'teacher') {
                matchedTeacher = docData as TeacherAccount;
              }
            }
          })
          .catch(() => null)
      );
    }

    if (database) {
      // Check email_accounts/{emailKey}
      queries.push(
        get(ref(database, 'email_accounts/' + emailKey))
          .then(snap => {
            if (snap.exists()) {
              const val = snap.val();
              if (val?.teacherAccount && !matchedTeacher) {
                matchedTeacher = val.teacherAccount;
              }
            }
          })
          .catch(() => null)
      );

      // Check teachers collection
      queries.push(
        get(ref(database, 'teachers'))
          .then(snap => {
            if (snap.exists()) {
              snap.forEach(child => {
                const val = child.val() as TeacherAccount;
                const tEmail = (val.gmail || val.email || '').trim().toLowerCase();
                if (tEmail === cleanGmail && !matchedTeacher) {
                  matchedTeacher = val;
                }
              });
            }
          })
          .catch(() => null)
      );

      // Check schools/{cleanSchoolCode}/teachers
      if (cleanSchoolCode) {
        queries.push(
          get(ref(database, `schools/${cleanSchoolCode}/teachers`))
            .then(schoolSnap => {
              if (schoolSnap.exists()) {
                schoolSnap.forEach(child => {
                  const val = child.val() as TeacherAccount;
                  const tEmail = (val.gmail || val.email || '').trim().toLowerCase();
                  if (tEmail === cleanGmail && !matchedTeacher) {
                    matchedTeacher = val;
                  }
                });
              }
            })
            .catch(() => null)
        );
      }
    }

    await Promise.race([
      Promise.allSettled(queries),
      new Promise<void>(resolve => setTimeout(resolve, 3500))
    ]);

    if (matchedTeacher) {
      const t = matchedTeacher as TeacherAccount;
      if (t.status && t.status !== 'active') {
        return { found: true, valid: false, reason: 'status_inactive', teacher: t };
      }
      if (cleanSchoolCode && t.schoolCode && t.schoolCode.toUpperCase() !== cleanSchoolCode) {
        return { found: true, valid: false, reason: 'school_mismatch', teacher: t };
      }
      return { found: true, valid: true, teacher: t };
    }

    return { found: false, valid: false, reason: 'not_found' };
  }

  public async logUnauthorizedAttempt(email: string, schoolCode: string, reason: string) {
    try {
      const attemptId = `attempt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const payload = {
        attemptedEmail: email || 'unknown',
        enteredSchoolCode: schoolCode || 'unknown',
        reason,
        timestamp: new Date().toISOString()
      };
      if (database) {
        const attemptRefPath = ref(database, `unauthorizedAttempts/${attemptId}`);
        await set(attemptRefPath, payload).catch(() => {});
      }
      if (firestore && auth?.currentUser) {
        await fsSetDoc(fsDoc(firestore, `unauthorizedAttempts/${attemptId}`), payload).catch(() => {});
      }
    } catch (e) {
      console.warn('Error logging unauthorized attempt:', e);
    }
  }

  public async verifyAndSyncSchoolAdmin(
    uid: string,
    email: string,
    schoolCode: string,
    designation?: string,
    _password?: string
  ): Promise<{
    authorized: boolean;
    reason?: string;
    adminRecord?: {
      id: string;
      email: string;
      schoolCode: string;
      role: string;
      status: string;
      adminName: string;
      schoolName: string;
      designation?: string;
      createdAt: string;
    };
  }> {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanSchoolCode = this.sanitizeSchoolCode(schoolCode);
    const nowIso = new Date().toISOString();

    if (!cleanEmail || !cleanSchoolCode) {
      return {
        authorized: false,
        reason: 'Access Denied\n\nThis Gmail account is not authorized to access this School Admin Panel.'
      };
    }

    const PRE_AUTHORIZED_EMAILS = new Set([
      'gelwin72@gmail.com',
      'joicegeorge1910@gmail.com',
      'lincythomas1911@gmail.com'
    ]);

    if (!PRE_AUTHORIZED_EMAILS.has(cleanEmail) || cleanSchoolCode !== 'SSHSS@111213') {
      return {
        authorized: false,
        reason: 'Access Denied\n\nOnly pre-authorized school admin Gmail accounts with School Code SSHSS@111213 are permitted to access the School Admin Panel.'
      };
    }

    const adminNameDetermined = designation || (
      cleanEmail.includes('gelwin') ? 'Gelwin' :
      cleanEmail.includes('joice') ? 'Joice George' :
      cleanEmail.includes('lincy') ? 'Lincy Thomas' : 'School Administrator'
    );

    const resolvedUid = auth?.currentUser?.uid || uid;
    if (!resolvedUid) {
      return {
        authorized: false,
        reason: 'Firebase Authentication is required before entering the School Admin Panel.'
      };
    }
    const emailKey = this.sanitizeEmailKey(cleanEmail);

    const adminData: Record<string, any> = {
      id: resolvedUid,
      uid: resolvedUid,
      email: cleanEmail,
      gmail: cleanEmail,
      schoolCode: cleanSchoolCode,
      role: 'schoolAdmin',
      status: 'active',
      adminName: adminNameDetermined,
      schoolName: "St. Sebastian's Higher Secondary School Koodaranhi",
      designation: designation || 'Principal & School Administrator',
      createdAt: nowIso,
      updatedAt: nowIso
    };

    // Notify Express admin bootstrap in background only when not on static hosting (e.g. GitHub Pages)
    const isStaticHost = typeof window !== 'undefined' && (
      window.location.hostname.endsWith('.github.io') ||
      window.location.protocol === 'file:'
    );
    if (auth?.currentUser && !isStaticHost) {
      auth.currentUser.getIdToken()
        .then((idToken) =>
          fetch('/api/admin/bootstrap', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${idToken}`
            },
            body: JSON.stringify({
              schoolCode: cleanSchoolCode,
              adminName: adminNameDetermined,
              schoolName: adminData.schoolName,
              designation: adminData.designation
            })
          }).catch(() => null)
        )
        .catch(() => null);
    }

    if (database) {
      try {
        const updates: Record<string, any> = {};
        updates[`schoolAdmins/${resolvedUid}`] = adminData;
        updates[`schools/${cleanSchoolCode}/schoolAdmins/${resolvedUid}`] = adminData;
        updates[`schools/${cleanSchoolCode}/adminProfile`] = adminData;
        updates[`admin_credentials/${emailKey}`] = {
          uid: resolvedUid,
          email: cleanEmail,
          gmail: cleanEmail,
          schoolCode: cleanSchoolCode,
          schoolName: adminData.schoolName,
          role: 'admin',
          updatedAt: nowIso
        };
        update(ref(database), updates).catch(e => console.warn('RTDB admin sync bg note:', e));
      } catch (e) {}
    }

    if (firestore) {
      try {
        // Create/update /admins/{uid} and /users/{uid} in parallel first
        await Promise.all([
          fsSetDoc(fsDoc(firestore, `admins/${resolvedUid}`), adminData, { merge: true }),
          fsSetDoc(fsDoc(firestore, `users/${resolvedUid}`), {
            userId: resolvedUid,
            uid: resolvedUid,
            email: cleanEmail,
            gmail: cleanEmail,
            role: 'admin',
            schoolCode: cleanSchoolCode,
            schoolName: adminData.schoolName,
            active: true,
            status: 'active',
            displayName: adminData.adminName,
            name: adminData.adminName,
            updatedAt: nowIso
          }, { merge: true })
        ]);

        Promise.allSettled([
          fsSetDoc(fsDoc(firestore, `schoolAdmins/${resolvedUid}`), adminData, { merge: true }),
          fsSetDoc(fsDoc(firestore, `schools/${cleanSchoolCode}/schoolAdmins/${resolvedUid}`), adminData, { merge: true }),
          fsSetDoc(fsDoc(firestore, `admin_credentials/${emailKey}`), {
            uid: resolvedUid,
            email: cleanEmail,
            gmail: cleanEmail,
            schoolCode: cleanSchoolCode,
            schoolName: adminData.schoolName,
            role: 'admin',
            updatedAt: nowIso
          }, { merge: true })
        ]).catch(() => {});
      } catch (e) {
        console.error('Firestore admin sync error:', e);
        handleFirestoreError(e, OperationType.WRITE, `admins/${resolvedUid}`);
      }
    }

    return {
      authorized: true,
      adminRecord: {
        id: adminData.id,
        email: cleanEmail,
        schoolCode: cleanSchoolCode,
        role: 'schoolAdmin',
        status: 'active',
        adminName: adminData.adminName,
        schoolName: adminData.schoolName,
        designation: adminData.designation,
        createdAt: adminData.createdAt
      }
    };
  }

  public async recordLoginActivity(
    schoolCode: string,
    payload: {
      email: string;
      accessMethod: 'Teacher Sign-Up' | 'Teacher Login' | 'School Admin Panel';
      role: 'teacher' | 'admin';
      success: boolean;
      details?: string;
    }
  ): Promise<void> {
    const cleanCode = this.sanitizeSchoolCode(schoolCode);
    const actId = `login-act-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();

    const activityItem = {
      id: actId,
      schoolCode: cleanCode,
      email: payload.email,
      accessMethod: payload.accessMethod,
      role: payload.role,
      success: payload.success,
      details: payload.details || `${payload.email} accessed via ${payload.accessMethod}`,
      timestamp: now,
      activityType: 'login_access'
    };

    const generalActivity = {
      id: actId,
      schoolCode: cleanCode,
      teacherId: payload.email,
      teacherName: payload.email,
      activityType: 'login',
      description: `[${payload.accessMethod}] ${payload.email} ${payload.success ? 'logged in successfully' : 'login failed'}`,
      timestamp: now
    };

    if (database) {
      try {
        await set(ref(database, `schools/${cleanCode}/loginActivities/${actId}`), activityItem).catch(() => {});
        await set(ref(database, `schools/${cleanCode}/activities/${actId}`), generalActivity).catch(() => {});
      } catch (e) {
        console.warn('Error recording login activity to RTDB:', e);
      }
    }

    if (firestore) {
      try {
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/loginActivities/${actId}`), activityItem, { merge: true }).catch(() => {});
        await fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/activities/${actId}`), generalActivity, { merge: true }).catch(() => {});
      } catch (e) {}
    }
  }

  public scheduleAutoSync(immediate: boolean = false) {
    const syncEmail = this.getActiveSyncEmail();
    if (!auth?.currentUser && !syncEmail) return;
    if (this.isApplyingRemoteUpdate) return;
    if (this.quotaExhaustedUntil > Date.now()) return;

    // Immediately reflect saving state so user has instantaneous feedback
    this.setSaveState('saving');

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // 150ms ultra-fast auto-save window for instantaneous response
    const delay = immediate ? 10 : 150;
    this.debounceTimer = setTimeout(() => {
      this.pushToCloud();
    }, delay);
  }
}

export const CloudSync = new CloudSyncManager();

registerStorageMutationListener(() => {
  CloudSync.scheduleAutoSync();
});
