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
  AppDataBackup,
  TeacherAccount,
  SchoolAdminAccount,
  PrincipalBroadcast,
  AuthSession,
  AuthRole,
  TimetableSlot,
  TimetableDay,
  PeriodTimingConfig,
  AuditLogItem
} from '../types';

const storageMutationListeners = new Set<() => void>();
let isMutationSilenced = false;

export const setStorageMutationSilenced = (silenced: boolean) => {
  isMutationSilenced = silenced;
};

export const registerStorageMutationListener = (cb: () => void) => {
  storageMutationListeners.add(cb);
  return () => {
    storageMutationListeners.delete(cb);
  };
};

const notifyMutation = () => {
  if (isMutationSilenced) return;
  const dispatch = () => {
    storageMutationListeners.forEach(cb => {
      try {
        cb();
      } catch (e) {
        console.warn('Storage mutation callback failed', e);
      }
    });
  };
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(dispatch);
  } else {
    setTimeout(dispatch, 0);
  }
};

const STORAGE_KEYS = {
  SCHOOL_PROFILE: 'hss_school_profile',
  CLASS_INFO: 'hss_class_info',
  TEACHER_INFO: 'hss_teacher_info',
  STUDENTS: 'hss_students_list',
  ATTENDANCE: 'hss_attendance_records',
  EXAMS: 'hss_exams_list',
  EXAM_MARKS: 'hss_exam_marks_map',
  REMINDERS: 'hss_reminders_list',
  SETTINGS: 'hss_app_settings',
  INITIALIZED: 'hss_app_initialized_v2',
  TEACHER_ACCOUNTS: 'hss_teacher_accounts_v1',
  SCHOOL_ADMINS: 'hss_school_admins_v1',
  AUTH_SESSION: 'hss_auth_session_v1',
  CLASSES_CATALOG: 'hss_classes_catalog_v2',
  ACTIVE_CLASS_ID: 'hss_active_class_id_v2',
  PRINCIPAL_BROADCASTS: 'hss_principal_broadcasts_v1',
  TIMETABLES: 'hss_timetables_catalog_v2',
  TIMETABLE_PREFS: 'hss_timetable_prefs_v1',
  AUDIT_LOGS: 'hss_audit_logs_v1'
};

export interface ParsedDateOfBirth {
  year: number;
  month: number; // 0-indexed (0 = Jan, 11 = Dec)
  day: number;
  formattedYmd: string; // YYYY-MM-DD
  displayStr: string;   // e.g. "15 May 1990"
}

export function parseDateOfBirth(dobStr?: string): ParsedDateOfBirth | null {
  if (!dobStr || typeof dobStr !== 'string') return null;
  const clean = dobStr.trim();
  if (!clean || clean === '-' || clean === 'N/A' || clean === 'Not Specified') return null;

  let y = 0;
  let m = 0; // 1-12
  let d = 0;

  // Case 1: YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  const ymdMatch = clean.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymdMatch) {
    y = parseInt(ymdMatch[1], 10);
    m = parseInt(ymdMatch[2], 10);
    d = parseInt(ymdMatch[3], 10);
  } else {
    // Case 2: DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
    const dmyMatch = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (dmyMatch) {
      d = parseInt(dmyMatch[1], 10);
      m = parseInt(dmyMatch[2], 10);
      y = parseInt(dmyMatch[3], 10);
    } else {
      // Case 3: Standard ISO / Date constructor parse
      const parsed = new Date(clean);
      if (!isNaN(parsed.getTime())) {
        y = parsed.getFullYear();
        m = parsed.getMonth() + 1;
        d = parsed.getDate();
      }
    }
  }

  if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    const dateObj = new Date(y, m - 1, d);
    const displayStr = dateObj.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
    return {
      year: y,
      month: m - 1,
      day: d,
      formattedYmd: `${y}-${pad(m)}-${pad(d)}`,
      displayStr
    };
  }
  return null;
}

export const DEFAULT_PERIOD_TIMINGS: PeriodTimingConfig[] = [
  { periodNumber: 1, label: 'Period 1', startTime: '09:30 AM', endTime: '10:15 AM' },
  { periodNumber: 2, label: 'Period 2', startTime: '10:15 AM', endTime: '11:00 AM', isBreakAfter: true, breakLabel: 'Short Recess (10m)' },
  { periodNumber: 3, label: 'Period 3', startTime: '11:10 AM', endTime: '11:55 AM' },
  { periodNumber: 4, label: 'Period 4', startTime: '11:55 AM', endTime: '12:40 PM', isBreakAfter: true, breakLabel: 'Lunch Break (45m)' },
  { periodNumber: 5, label: 'Period 5', startTime: '01:25 PM', endTime: '02:10 PM' },
  { periodNumber: 6, label: 'Period 6', startTime: '02:10 PM', endTime: '02:55 PM' }
];

export const TIMETABLE_DAYS: TimetableDay[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday'
];

export const DEFAULT_SCHOOL_ADMIN: SchoolAdminAccount = {
  id: '',
  schoolName: "St.Sebastian's Higher Secondary School",
  schoolCode: 'SSHSS@111213',
  adminPassword: '',
  adminName: 'Principal',
  designation: 'Principal & School Administrator',
  email: '',
  phone: '',
  role: 'admin',
  createdAt: new Date().toISOString()
};

export const DEFAULT_TEACHER_ACCOUNTS: TeacherAccount[] = [];

export const DEFAULT_PRINCIPAL_BROADCASTS: PrincipalBroadcast[] = [];

export const DEFAULT_SCHOOL_PROFILE: SchoolProfile = {
  schoolName: "St.Sebastian's Higher Secondary School",
  schoolAddress: '',
  schoolCode: 'SSHSS@111213',
  schoolPhone: '',
  schoolEmail: '',
  principalName: 'Principal',
  principalPhone: ''
};

export const DEFAULT_CLASSES_CATALOG: ClassItem[] = [];

export const DEFAULT_CLASS_INFO: ClassInfo = {
  id: '',
  standard: '',
  stream: '',
  section: '',
  className: '',
  academicYear: '',
  classStrength: 0
};

export const DEFAULT_TEACHER_INFO: TeacherInfo = {
  teacherName: '',
  phone: '',
  email: '',
  designation: ''
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  accentColor: 'purple',
  customColorHex: '#9333ea',
  uiAppearance: 'modern',
  gradingSystem: 'kerala_hss',
  passingPercentage: 30,
  notificationsEnabled: true,
  autoBackupPrompt: true
};

export const SEED_STUDENTS: Student[] = [];
export const SEED_EXAMS: Exam[] = [];
export const SEED_EXAM_MARKS: Record<string, ExamMarksRecord> = {};
export const SEED_STUDENTS_12B: Student[] = [];
export const SEED_STUDENTS_11COM: Student[] = [];
export const SEED_STUDENTS_11SCI: Student[] = [];
export const SEED_ATTENDANCE: AttendanceRecord[] = [];
export const SEED_REMINDERS: Reminder[] = [];

/**
 * Storage Layer Service
 */
export const StorageService = {
  init() {
    try {
      const freshSlatePurged = localStorage.getItem('hss_fresh_slate_v4');

      if (!freshSlatePurged) {
        // Complete purge of all previous test/dummy data from local storage
        this.saveTeacherAccounts([]);
        this.saveClassesList([]);
        this.saveStudents([]);
        this.saveAttendance([]);
        this.saveExams([]);
        this.saveExamMarksMap({});
        this.saveReminders([]);
        this.saveTimetables([]);
        this.saveAuditLogs([]);
        this.saveSchoolProfile(DEFAULT_SCHOOL_PROFILE);
        this.saveClassInfo(DEFAULT_CLASS_INFO);
        this.saveTeacherInfo(DEFAULT_TEACHER_INFO);
        this.saveSettings(DEFAULT_SETTINGS);

        this.setAuthSession({
          isLoggedIn: false,
          role: null,
          currentTeacher: null,
          currentAdmin: null
        });

        // Purge any class-scoped dynamic storage keys
        try {
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (
              k.startsWith('hss_students_') ||
              k.startsWith('hss_attendance_') ||
              k.startsWith('hss_exams_') ||
              k.startsWith('hss_exam_marks_') ||
              k.startsWith('hss_class_info_') ||
              k.startsWith('hss_active_class_')
            )) {
              keysToRemove.push(k);
            }
          }
          keysToRemove.forEach(k => localStorage.removeItem(k));
        } catch {}

        localStorage.setItem('hss_fresh_slate_v4', 'true');
        localStorage.setItem(STORAGE_KEYS.INITIALIZED, 'true');
      }

      const initialized = localStorage.getItem(STORAGE_KEYS.INITIALIZED);
      if (!initialized) {
        this.saveSchoolProfile(DEFAULT_SCHOOL_PROFILE);
        this.saveClassInfo(DEFAULT_CLASS_INFO);
        this.saveTeacherInfo(DEFAULT_TEACHER_INFO);
        this.saveStudents([]);
        this.saveAttendance([]);
        this.saveExams([]);
        this.saveExamMarksMap({});
        this.saveReminders([]);
        this.saveSettings(DEFAULT_SETTINGS);
        this.saveClassesList([]);
        this.saveTimetables([]);
        localStorage.setItem(STORAGE_KEYS.INITIALIZED, 'true');
      }
    } catch (e) {
      console.error('Storage initialization failed:', e);
    }
  },

  getSchoolProfile(): SchoolProfile {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.SCHOOL_PROFILE);
      if (val) {
        const parsed = JSON.parse(val);
        return {
          ...DEFAULT_SCHOOL_PROFILE,
          ...parsed,
          schoolName: (parsed.schoolName && parsed.schoolName.trim()) ? parsed.schoolName.trim() : DEFAULT_SCHOOL_PROFILE.schoolName,
          schoolCode: (parsed.schoolCode && parsed.schoolCode.trim())
            ? parsed.schoolCode.trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_\-.@]/g, '_').slice(0, 64)
            : DEFAULT_SCHOOL_PROFILE.schoolCode,
          principalName: (parsed.principalName && parsed.principalName.trim()) ? parsed.principalName.trim() : DEFAULT_SCHOOL_PROFILE.principalName
        };
      }
      return DEFAULT_SCHOOL_PROFILE;
    } catch {
      return DEFAULT_SCHOOL_PROFILE;
    }
  },

  saveSchoolProfile(profile: SchoolProfile) {
    localStorage.setItem(STORAGE_KEYS.SCHOOL_PROFILE, JSON.stringify(profile));
    notifyMutation();
  },

  getClassesList(): ClassItem[] {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.CLASSES_CATALOG);
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
      return [];
    } catch {
      return [];
    }
  },

  saveClassesList(classes: ClassItem[]) {
    // Deduplicate by ID to prevent any duplicate entries
    const seenIds = new Set<string>();
    const uniqueClasses: ClassItem[] = [];
    for (const c of classes) {
      if (c && c.id && !seenIds.has(c.id)) {
        seenIds.add(c.id);
        uniqueClasses.push(c);
      }
    }
    localStorage.setItem(STORAGE_KEYS.CLASSES_CATALOG, JSON.stringify(uniqueClasses));
    notifyMutation();
  },

  getClassesByTeacher(teacherIdOrUid?: string, teacherEmail?: string, teacherAccount?: TeacherAccount | null): ClassItem[] {
    const classes = this.getClassesList();
    const session = this.getAuthSession();
    const teacher = teacherAccount || session.currentTeacher;

    const cleanUid = (teacherIdOrUid || teacher?.id || teacher?.uid || '').trim();
    const cleanEmail = (teacherEmail || teacher?.email || teacher?.gmail || '').trim().toLowerCase();
    const teacherClassId = (teacher?.teacherClassId || '').trim();
    const assignedClass = (teacher?.assignedClass || '').trim().toLowerCase();
    const teacherName = (teacher?.name || '').trim().toLowerCase();
    const teacherSchool = (teacher?.schoolCode || '').trim().toUpperCase();

    if (!cleanUid && !cleanEmail && !teacherClassId && !assignedClass) return classes;

    const matched = classes.filter(c => {
      if (!c) return false;
      const cId = (c.id || '').trim();
      if (teacherClassId && cId === teacherClassId) return true;

      const cUid = (c.teacherId || c.teacherUid || c.createdByTeacherId || '').trim();
      if (cleanUid && cUid === cleanUid) return true;

      const cEmail = (c.createdByTeacherEmail || '').trim().toLowerCase();
      if (cleanEmail && cEmail === cleanEmail) return true;

      const cName = (c.teacherName || '').trim().toLowerCase();
      const cSchool = (c.schoolCode || '').trim().toUpperCase();
      const cClassName = (c.className || '').trim().toLowerCase();

      if (assignedClass && cClassName === assignedClass && (!teacherSchool || !cSchool || teacherSchool === cSchool)) {
        return true;
      }
      if (teacherName && cName === teacherName && (!teacherSchool || !cSchool || teacherSchool === cSchool)) {
        return true;
      }
      return false;
    });

    // Sort by createdAt ascending (the original first-created classroom is first)
    return matched.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  },

  getActiveClassId(forTeacherUid?: string, forTeacherEmail?: string, teacherAccount?: TeacherAccount | null): string {
    try {
      const session = this.getAuthSession();
      const teacher = teacherAccount || session.currentTeacher;
      const targetUid = forTeacherUid || teacher?.id || teacher?.uid || '';
      const targetEmail = (forTeacherEmail || teacher?.email || teacher?.gmail || '').trim().toLowerCase();

      const classes = this.getClassesList();
      if (classes.length === 0) return '';

      const currentActiveId = localStorage.getItem(STORAGE_KEYS.ACTIVE_CLASS_ID);

      // If a teacher is active/specified, ensure active class belongs to this teacher's original/created classes
      if (targetUid || targetEmail || teacher) {
        const teacherClasses = this.getClassesByTeacher(targetUid, targetEmail, teacher);
        if (teacherClasses.length > 0) {
          const matched = teacherClasses.find(c => c.id === currentActiveId);
          if (matched) {
            return matched.id;
          }
          // Default to this teacher's original (first created) class
          const preferred = teacherClasses[0];
          this.setActiveClassId(preferred.id);
          return preferred.id;
        }
      }

      if (currentActiveId && classes.some(c => c.id === currentActiveId)) {
        return currentActiveId;
      }

      const defaultId = classes[0]?.id || '';
      if (defaultId) {
        this.setActiveClassId(defaultId);
      }
      return defaultId;
    } catch {
      return '';
    }
  },

  setActiveClassId(id: string) {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_CLASS_ID, id);
    // Also keep CLASS_INFO in sync for backwards compatibility
    const classes = this.getClassesList();
    const active = classes.find(c => c.id === id);
    if (active) {
      this.saveClassInfo({
        id: active.id,
        standard: active.standard,
        stream: active.stream,
        section: active.section,
        className: active.className,
        academicYear: active.academicYear,
        classStrength: active.classStrength
      });
    }
    notifyMutation();
  },

  getClassById(classId: string): ClassItem | undefined {
    const classes = this.getClassesList();
    return classes.find(c => c.id === classId);
  },

  addNewClass(newClass: ClassItem, initialStudents?: Student[]): ClassItem {
    const classes = this.getClassesList();
    const session = this.getAuthSession();
    const currentTeacher = session.currentTeacher;
    const currentSchool = this.getSchoolProfile();

    const teacherUid = newClass.teacherUid || newClass.teacherId || currentTeacher?.uid || currentTeacher?.id || '';
    const teacherEmail = (newClass.createdByTeacherEmail || currentTeacher?.email || currentTeacher?.gmail || '').trim().toLowerCase();

    // Ensure unique ID
    if (!newClass.id) {
      newClass.id = `cls-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
    }
    if (!newClass.teacherId && teacherUid) {
      newClass.teacherId = teacherUid;
    }
    if (!newClass.teacherUid && teacherUid) {
      newClass.teacherUid = teacherUid;
    }
    if (!newClass.teacherName && currentTeacher?.name) {
      newClass.teacherName = currentTeacher.name;
    }
    if (!newClass.schoolCode) {
      newClass.schoolCode = currentTeacher?.schoolCode || currentSchool.schoolCode || '';
    }
    if (!newClass.createdAt) {
      newClass.createdAt = new Date().toISOString();
    }
    newClass.isTeacherCreated = true;
    if (!newClass.createdByTeacherId && teacherUid) {
      newClass.createdByTeacherId = teacherUid;
    }
    if (!newClass.createdByTeacherEmail && teacherEmail) {
      newClass.createdByTeacherEmail = teacherEmail;
    }

    // Deduplication check:
    // 1. Direct ID match
    let existingIdx = classes.findIndex(c => c.id === newClass.id);

    // 2. Teacher + Standard + Section match (prevent duplicate classrooms for same teacher)
    if (existingIdx < 0 && (teacherUid || teacherEmail)) {
      const cleanStd = (newClass.standard || '').trim().toLowerCase();
      const cleanSec = (newClass.section || '').trim().toLowerCase();
      const cleanName = (newClass.className || '').trim().toLowerCase();

      existingIdx = classes.findIndex(c => {
        const cTeacherId = c.teacherId || c.teacherUid || c.createdByTeacherId || '';
        const cTeacherEmail = (c.createdByTeacherEmail || '').trim().toLowerCase();
        const isSameTeacher = (teacherUid && cTeacherId === teacherUid) || (teacherEmail && cTeacherEmail === teacherEmail);
        if (!isSameTeacher) return false;

        if (cleanStd && cleanSec && c.standard.trim().toLowerCase() === cleanStd && c.section.trim().toLowerCase() === cleanSec) {
          return true;
        }
        if (cleanName && c.className.trim().toLowerCase() === cleanName) {
          return true;
        }
        return false;
      });
    }

    const preparedStudents = (initialStudents || []).map(s => ({
      ...s,
      classId: newClass.id,
      teacherId: newClass.teacherId,
      schoolCode: newClass.schoolCode
    }));

    if (existingIdx >= 0) {
      const existingClass = classes[existingIdx];
      newClass.id = existingClass.id;
      const preservedCreatedAt = existingClass.createdAt || newClass.createdAt;
      classes[existingIdx] = {
        ...existingClass,
        ...newClass,
        id: existingClass.id,
        createdAt: preservedCreatedAt
      };

      if (preparedStudents.length > 0) {
        const studentsForExisting = preparedStudents.map(s => ({ ...s, classId: existingClass.id }));
        this.saveStudents(studentsForExisting, existingClass.id);
        classes[existingIdx].classStrength = studentsForExisting.length;
      }
      this.saveClassesList(classes);
      notifyMutation();
      return classes[existingIdx];
    }

    newClass.classStrength = preparedStudents.length;
    classes.push(newClass);
    this.saveClassesList(classes);

    this.saveStudents(preparedStudents, newClass.id);
    this.saveAttendance([], newClass.id);
    this.saveExams([], newClass.id);
    this.saveExamMarksMap({}, newClass.id);
    notifyMutation();

    return newClass;
  },

  updateClass(updated: ClassItem) {
    const classes = this.getClassesList();
    const idx = classes.findIndex(c => c.id === updated.id);
    if (idx >= 0) {
      classes[idx] = { ...classes[idx], ...updated };
      this.saveClassesList(classes);
      if (this.getActiveClassId() === updated.id) {
        this.saveClassInfo({
          id: updated.id,
          standard: updated.standard,
          stream: updated.stream,
          section: updated.section,
          className: updated.className,
          academicYear: updated.academicYear,
          classStrength: updated.classStrength
        });
      }
    }
    notifyMutation();
  },

  deleteClass(classId: string): boolean {
    let classes = this.getClassesList();
    classes = classes.filter(c => c.id !== classId);
    this.saveClassesList(classes);

    // Clean up scoped storage
    localStorage.removeItem(`hss_students_${classId}`);
    localStorage.removeItem(`hss_attendance_${classId}`);
    localStorage.removeItem(`hss_exams_${classId}`);
    localStorage.removeItem(`hss_marks_${classId}`);
    localStorage.removeItem(`hss_class_info_${classId}`);

    if (this.getActiveClassId() === classId) {
      this.setActiveClassId(classes[0]?.id || '');
    }
    notifyMutation();
    return true;
  },

  getClassInfo(classId?: string): ClassInfo {
    try {
      const activeId = classId || this.getActiveClassId();
      const classes = this.getClassesList();
      let current = classes.find(c => c.id === activeId);
      if (!current) {
        const teacherClasses = this.getClassesByTeacher();
        if (teacherClasses.length > 0) {
          current = teacherClasses[0];
          this.setActiveClassId(current.id);
        }
      }
      if (current) {
        return {
          id: current.id,
          standard: current.standard,
          stream: current.stream,
          section: current.section,
          className: current.className,
          academicYear: current.academicYear,
          classStrength: current.classStrength
        };
      }
      const val = localStorage.getItem(STORAGE_KEYS.CLASS_INFO);
      return val ? JSON.parse(val) : DEFAULT_CLASS_INFO;
    } catch {
      return DEFAULT_CLASS_INFO;
    }
  },

  saveClassInfo(info: ClassInfo, classId?: string) {
    const activeId = classId || info.id || this.getActiveClassId();
    localStorage.setItem(STORAGE_KEYS.CLASS_INFO, JSON.stringify(info));
    // Also sync in catalog if exists
    const classes = this.getClassesList();
    const idx = classes.findIndex(c => c.id === activeId);
    if (idx >= 0) {
      classes[idx] = {
        ...classes[idx],
        standard: info.standard,
        stream: info.stream,
        section: info.section,
        className: info.className,
        academicYear: info.academicYear,
        classStrength: info.classStrength
      };
      this.saveClassesList(classes);
    }
    notifyMutation();
  },

  getTeacherInfo(): TeacherInfo {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.TEACHER_INFO);
      return val ? JSON.parse(val) : DEFAULT_TEACHER_INFO;
    } catch {
      return DEFAULT_TEACHER_INFO;
    }
  },

  saveTeacherInfo(info: TeacherInfo) {
    localStorage.setItem(STORAGE_KEYS.TEACHER_INFO, JSON.stringify(info));
    
    // Auto-sync with TeacherAccount catalog and AuthSession
    try {
      const session = this.getAuthSession();
      const accounts = this.getTeacherAccounts();
      const schoolProfile = this.getSchoolProfile();

      // Find matching teacher account by active session ID, email, or name
      const targetId = session.currentTeacher?.id;
      let matchedIdx = accounts.findIndex(a => targetId && a.id === targetId);
      
      if (matchedIdx === -1 && info.email) {
        matchedIdx = accounts.findIndex(a => a.email && a.email.toLowerCase() === info.email.toLowerCase());
      }
      if (matchedIdx === -1 && info.phone) {
        matchedIdx = accounts.findIndex(a => a.phone && a.phone === info.phone);
      }

      if (matchedIdx >= 0) {
        accounts[matchedIdx] = {
          ...accounts[matchedIdx],
          name: info.teacherName || accounts[matchedIdx].name,
          phone: info.phone || accounts[matchedIdx].phone,
          email: info.email || accounts[matchedIdx].email,
          designation: info.designation || accounts[matchedIdx].designation,
          avatar: info.avatar || accounts[matchedIdx].avatar,
          photoUrl: info.photoUrl || accounts[matchedIdx].photoUrl,
          dob: info.dob || accounts[matchedIdx].dob,
          academicYear: info.academicYear || accounts[matchedIdx].academicYear,
          lastActiveAt: new Date().toISOString()
        };
        this.saveTeacherAccounts(accounts);

        // Update active session
        if (session.currentTeacher && (session.currentTeacher.id === accounts[matchedIdx].id || session.currentTeacher.email === accounts[matchedIdx].email)) {
          session.currentTeacher = { ...accounts[matchedIdx] };
          this.setAuthSession(session);
        }
      } else if (info.teacherName && info.teacherName.trim() && info.email && info.email.trim()) {
        // Create new teacher record linked to this school code
        const newTeacher: TeacherAccount = {
          id: `teach-${Date.now().toString(36)}`,
          name: info.teacherName.trim(),
          email: info.email.trim(),
          phone: info.phone ? info.phone.trim() : '',
          schoolName: schoolProfile.schoolName || 'Higher Secondary School',
          schoolCode: schoolProfile.schoolCode,
          academicYear: info.academicYear,
          designation: info.designation || 'Class Teacher',
          avatar: info.avatar || '👨‍🏫',
          photoUrl: info.photoUrl,
          dob: info.dob,
          createdAt: new Date().toISOString()
        };
        accounts.push(newTeacher);
        this.saveTeacherAccounts(accounts);
        if (session.isLoggedIn && session.role === 'teacher') {
          session.currentTeacher = newTeacher;
          this.setAuthSession(session);
        }
      }
    } catch {
      // Ignored
    }

    notifyMutation();
  },

  getStudents(classId?: string): Student[] {
    try {
      const targetId = classId || this.getActiveClassId();
      if (!targetId) return [];
      const key = `hss_students_${targetId}`;
      const val = localStorage.getItem(key);
      if (val) {
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      }
      return [];
    } catch {
      return [];
    }
  },

  saveStudents(students: Student[], classId?: string) {
    const targetId = classId || this.getActiveClassId();
    if (!targetId) return;
    const session = this.getAuthSession();
    const currentTeacher = session.currentTeacher;
    const currentSchool = this.getSchoolProfile();

    const taggedStudents = (students || []).map(s => ({
      ...s,
      classId: s.classId || targetId,
      teacherId: s.teacherId || currentTeacher?.id,
      schoolCode: s.schoolCode || currentTeacher?.schoolCode || currentSchool.schoolCode
    }));

    localStorage.setItem(`hss_students_${targetId}`, JSON.stringify(taggedStudents));
    // Update class strength in catalog
    const classes = this.getClassesList();
    const idx = classes.findIndex(c => c.id === targetId);
    if (idx >= 0) {
      classes[idx].classStrength = taggedStudents.length;
      this.saveClassesList(classes);
    }
    notifyMutation();
  },

  getAttendance(classId?: string): AttendanceRecord[] {
    try {
      const targetId = classId || this.getActiveClassId();
      if (!targetId) return [];
      const key = `hss_attendance_${targetId}`;
      const val = localStorage.getItem(key);
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          return parsed.filter(Boolean).map((a: any) => ({
            ...a,
            presentStudentIds: Array.isArray(a?.presentStudentIds) ? a.presentStudentIds : [],
            absentStudentIds: Array.isArray(a?.absentStudentIds) ? a.absentStudentIds : [],
            onDutyStudentIds: Array.isArray(a?.onDutyStudentIds) ? a.onDutyStudentIds : []
          }));
        }
      }
      return [];
    } catch {
      return [];
    }
  },

  saveAttendance(attendance: AttendanceRecord[], classId?: string) {
    const targetId = classId || this.getActiveClassId();
    if (!targetId) return;
    const session = this.getAuthSession();
    const currentTeacher = session.currentTeacher;

    const taggedAttendance = (attendance || []).map(a => ({
      ...a,
      classId: a.classId || targetId,
      teacherId: a.teacherId || currentTeacher?.id
    }));

    localStorage.setItem(`hss_attendance_${targetId}`, JSON.stringify(taggedAttendance));
    notifyMutation();
  },

  getExams(classId?: string): Exam[] {
    try {
      const targetId = classId || this.getActiveClassId();
      if (!targetId) return [];
      const key = `hss_exams_${targetId}`;
      const val = localStorage.getItem(key);
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          return parsed.map((e: any) => ({
            ...e,
            subjects: Array.isArray(e?.subjects) ? e.subjects : []
          }));
        }
      }
      return [];
    } catch {
      return [];
    }
  },

  saveExams(exams: Exam[], classId?: string) {
    const targetId = classId || this.getActiveClassId();
    if (!targetId) return;
    const session = this.getAuthSession();
    const currentTeacher = session.currentTeacher;

    const taggedExams = (exams || []).map(e => ({
      ...e,
      classId: e.classId || targetId,
      teacherId: e.teacherId || currentTeacher?.id
    }));

    localStorage.setItem(`hss_exams_${targetId}`, JSON.stringify(taggedExams));
    notifyMutation();
  },

  getExamMarksMap(classId?: string): Record<string, ExamMarksRecord> {
    try {
      const targetId = classId || this.getActiveClassId();
      if (!targetId) return {};
      const key = `hss_marks_${targetId}`;
      const val = localStorage.getItem(key);
      if (val) return JSON.parse(val);
      return {};
    } catch {
      return {};
    }
  },

  saveExamMarksMap(marksMap: Record<string, ExamMarksRecord>, classId?: string) {
    const targetId = classId || this.getActiveClassId();
    if (!targetId) return;
    localStorage.setItem(`hss_marks_${targetId}`, JSON.stringify(marksMap));
    notifyMutation();
  },

  getReminders(): Reminder[] {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.REMINDERS);
      if (val) {
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : [];
      }
      return [];
    } catch {
      return [];
    }
  },

  saveReminders(reminders: Reminder[]) {
    localStorage.setItem(STORAGE_KEYS.REMINDERS, JSON.stringify(reminders));
    notifyMutation();
  },

  getSettings(): AppSettings {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      return val ? JSON.parse(val) : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  },

  saveSettings(settings: AppSettings) {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    notifyMutation();
  },

  exportFullBackup(): AppDataBackup {
    return {
      version: '1.0.0',
      backupDate: new Date().toISOString(),
      schoolProfile: this.getSchoolProfile(),
      classInfo: this.getClassInfo(),
      teacherInfo: this.getTeacherInfo(),
      students: this.getStudents(),
      attendance: this.getAttendance(),
      exams: this.getExams(),
      examMarks: this.getExamMarksMap(),
      reminders: this.getReminders(),
      settings: this.getSettings()
    };
  },

  restoreBackup(backupData: any): { success: boolean; message: string } {
    try {
      if (!backupData || typeof backupData !== 'object') {
        return { success: false, message: 'Invalid backup file structure.' };
      }

      if (backupData.schoolProfile) this.saveSchoolProfile(backupData.schoolProfile);
      if (backupData.classInfo) this.saveClassInfo(backupData.classInfo);
      if (backupData.teacherInfo) this.saveTeacherInfo(backupData.teacherInfo);
      if (Array.isArray(backupData.students)) this.saveStudents(backupData.students);
      if (Array.isArray(backupData.attendance)) this.saveAttendance(backupData.attendance);
      if (Array.isArray(backupData.exams)) this.saveExams(backupData.exams);
      if (backupData.examMarks) this.saveExamMarksMap(backupData.examMarks);
      if (Array.isArray(backupData.reminders)) this.saveReminders(backupData.reminders);
      if (backupData.settings) this.saveSettings(backupData.settings);

      return { success: true, message: 'Data restored successfully!' };
    } catch (e: any) {
      return { success: false, message: e.message || 'Error restoring data' };
    }
  },

  saveDailyAttendance(record: AttendanceRecord, classId?: string) {
    const list = this.getAttendance(classId);
    const idx = list.findIndex(r => r.date === record.date || r.id === record.id);
    if (idx >= 0) {
      list[idx] = record;
    } else {
      list.push(record);
    }
    this.saveAttendance(list, classId);
  },

  saveExamMarks(examId: string, marksRecord: ExamMarksRecord, classId?: string) {
    const map = this.getExamMarksMap(classId);
    map[examId] = marksRecord;
    this.saveExamMarksMap(map, classId);
  },

  exportAllDataAsJSON(): string {
    return JSON.stringify(this.exportFullBackup(), null, 2);
  },

  importBackupJSON(jsonString: string): boolean {
    try {
      const parsed = JSON.parse(jsonString);
      const res = this.restoreBackup(parsed);
      return res.success;
    } catch {
      return false;
    }
  },

  resetToDefaults() {
    this.resetToSeedData();
  },

  resetToSeedData() {
    this.saveSchoolProfile(DEFAULT_SCHOOL_PROFILE);
    this.saveClassInfo(DEFAULT_CLASS_INFO);
    this.saveTeacherInfo(DEFAULT_TEACHER_INFO);
    this.saveStudents([]);
    this.saveAttendance([]);
    this.saveExams([]);
    this.saveExamMarksMap({});
    this.saveReminders([]);
    this.saveSettings(DEFAULT_SETTINGS);
    this.saveClassesList([]);
    this.saveTimetables([]);
  },

  clearAllData() {
    Object.values(STORAGE_KEYS).forEach(key => {
      localStorage.removeItem(key);
    });
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('hss_') || k.includes('teacher') || k.includes('admin') || k.includes('school') || k.includes('auth') || k.includes('student') || k.includes('class') || k.includes('exam') || k.includes('attendance') || k.includes('timetable'))) {
        localStorage.removeItem(k);
      }
    }
    notifyMutation();
  },

  // Permanent Deletion Tracking
  getPermanentlyDeletedTeacherIds(): string[] {
    try {
      const val = localStorage.getItem('hss_permanently_deleted_teacher_ids_v1') || localStorage.getItem('hss_deleted_teacher_ids_v1');
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) return parsed;
      }
      return [];
    } catch {
      return [];
    }
  },

  addPermanentlyDeletedTeacherId(id: string, email?: string) {
    if (!id && !email) return;
    const deleted = this.getPermanentlyDeletedTeacherIds();
    const cleanEmail = (email || '').trim().toLowerCase();
    
    if (id && !deleted.includes(id)) {
      deleted.push(id);
    }
    if (cleanEmail && !deleted.includes(cleanEmail)) {
      deleted.push(cleanEmail);
    }
    localStorage.setItem('hss_permanently_deleted_teacher_ids_v1', JSON.stringify(deleted));
    localStorage.setItem('hss_deleted_teacher_ids_v1', JSON.stringify(deleted));
    // Ensure it's removed from temporary deleted list if present
    this.removeTemporarilyDeletedTeacherId(id, email);
    notifyMutation();
  },

  removePermanentlyDeletedTeacherId(id?: string, email?: string) {
    if (!id && !email) return;
    let deleted = this.getPermanentlyDeletedTeacherIds();
    if (deleted.length === 0) return;
    const cleanId = (id || '').trim().toLowerCase();
    const cleanEmail = (email || '').trim().toLowerCase();

    deleted = deleted.filter(item => {
      const cleanItem = (item || '').trim().toLowerCase();
      if (cleanId && cleanItem === cleanId) return false;
      if (cleanEmail && cleanItem === cleanEmail) return false;
      return true;
    });

    localStorage.setItem('hss_permanently_deleted_teacher_ids_v1', JSON.stringify(deleted));
    localStorage.setItem('hss_deleted_teacher_ids_v1', JSON.stringify(deleted));
    notifyMutation();
  },

  isTeacherPermanentlyDeleted(id?: string, email?: string): boolean {
    const deleted = this.getPermanentlyDeletedTeacherIds();
    if (deleted.length === 0) return false;
    const cleanId = (id || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    
    if (cleanId && deleted.includes(cleanId)) return true;
    if (cleanEmail && deleted.includes(cleanEmail)) return true;
    return false;
  },

  // Temporary Deletion Tracking
  getTemporarilyDeletedTeacherIds(): string[] {
    try {
      const val = localStorage.getItem('hss_temp_deleted_teacher_ids_v1');
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) return parsed;
      }
      return [];
    } catch {
      return [];
    }
  },

  addTemporarilyDeletedTeacherId(id: string, email?: string) {
    if (!id && !email) return;
    const tempDeleted = this.getTemporarilyDeletedTeacherIds();
    const cleanEmail = (email || '').trim().toLowerCase();

    if (id && !tempDeleted.includes(id)) {
      tempDeleted.push(id);
    }
    if (cleanEmail && !tempDeleted.includes(cleanEmail)) {
      tempDeleted.push(cleanEmail);
    }
    localStorage.setItem('hss_temp_deleted_teacher_ids_v1', JSON.stringify(tempDeleted));
    notifyMutation();
  },

  removeTemporarilyDeletedTeacherId(id?: string, email?: string) {
    if (!id && !email) return;
    let tempDeleted = this.getTemporarilyDeletedTeacherIds();
    if (tempDeleted.length === 0) return;
    const cleanId = (id || '').trim().toLowerCase();
    const cleanEmail = (email || '').trim().toLowerCase();

    tempDeleted = tempDeleted.filter(item => {
      const cleanItem = (item || '').trim().toLowerCase();
      if (cleanId && cleanItem === cleanId) return false;
      if (cleanEmail && cleanItem === cleanEmail) return false;
      return true;
    });

    localStorage.setItem('hss_temp_deleted_teacher_ids_v1', JSON.stringify(tempDeleted));
    notifyMutation();
  },

  isTeacherTemporarilyDeleted(id?: string, email?: string): boolean {
    const tempDeleted = this.getTemporarilyDeletedTeacherIds();
    if (tempDeleted.length === 0) return false;
    const cleanId = (id || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    
    if (cleanId && tempDeleted.includes(cleanId)) return true;
    if (cleanEmail && tempDeleted.includes(cleanEmail)) return true;
    return false;
  },

  // Combined Check for Active Filtering
  getDeletedTeacherIds(): string[] {
    return Array.from(new Set([...this.getPermanentlyDeletedTeacherIds(), ...this.getTemporarilyDeletedTeacherIds()]));
  },

  addDeletedTeacherId(id: string, email?: string) {
    this.addPermanentlyDeletedTeacherId(id, email);
  },

  removeDeletedTeacherId(id?: string, email?: string) {
    this.removePermanentlyDeletedTeacherId(id, email);
    this.removeTemporarilyDeletedTeacherId(id, email);
  },

  isTeacherDeleted(id?: string, email?: string): boolean {
    return this.isTeacherPermanentlyDeleted(id, email) || this.isTeacherTemporarilyDeleted(id, email);
  },

  getTeacherAccounts(): TeacherAccount[] {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.TEACHER_ACCOUNTS);
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          return parsed.filter(a => a && !this.isTeacherDeleted(a.id, a.email || a.gmail));
        }
      }
      return [];
    } catch {
      return [];
    }
  },

  saveTeacherAccounts(accounts: TeacherAccount[]) {
    const filtered = (accounts || []).filter(a => a && !this.isTeacherDeleted(a.id, a.email || a.gmail));
    localStorage.setItem(STORAGE_KEYS.TEACHER_ACCOUNTS, JSON.stringify(filtered));
    notifyMutation();
  },

  registerTeacherAccount(account: TeacherAccount): boolean {
    if (account) {
      if (this.isTeacherPermanentlyDeleted(account.id, account.email || account.gmail) || (account.uid && this.isTeacherPermanentlyDeleted(account.uid))) {
        return false;
      }
      this.removeTemporarilyDeletedTeacherId(account.id, account.email || account.gmail);
      if (account.uid) this.removeTemporarilyDeletedTeacherId(account.uid);
    }
    const accounts = this.getTeacherAccounts();
    const existing = accounts.find(
      a => (a.email && account.email && a.email.toLowerCase() === account.email.toLowerCase()) || 
           (a.phone && account.phone && a.phone === account.phone)
    );
    if (existing) {
      // Update existing if needed
      const idx = accounts.findIndex(a => a.id === existing.id || (a.email && account.email && a.email.toLowerCase() === account.email.toLowerCase()));
      if (idx >= 0) {
        accounts[idx] = { ...accounts[idx], ...account, status: 'active' };
        this.saveTeacherAccounts(accounts);
        return true;
      }
      return false;
    }
    accounts.push({ ...account, status: 'active' });
    this.saveTeacherAccounts(accounts);
    return true;
  },

  getTeachersBySchoolCode(schoolCode: string): TeacherAccount[] {
    const accounts = this.getTeacherAccounts();
    const cleanCode = (schoolCode || '').trim().toLowerCase();
    return accounts.filter(a => {
      const code = (a.schoolCode || '').trim().toLowerCase();
      return !cleanCode || code === cleanCode;
    });
  },

  updateTeacherAccount(account: TeacherAccount): boolean {
    if (!account) return false;
    if (this.isTeacherPermanentlyDeleted(account.id, account.email || account.gmail) || (account.uid && this.isTeacherPermanentlyDeleted(account.uid))) {
      return false;
    }
    this.removeTemporarilyDeletedTeacherId(account.id, account.email || account.gmail);
    if (account.uid) this.removeTemporarilyDeletedTeacherId(account.uid);

    const accounts = this.getTeacherAccounts();
    const cleanEmail = (account.email || account.gmail || '').trim().toLowerCase();
    const cleanId = (account.id || '').trim();
    const cleanUid = (account.uid || '').trim();

    const idx = accounts.findIndex(a => 
      (cleanId && a.id === cleanId) ||
      (cleanUid && (a.uid === cleanUid || a.id === cleanUid)) ||
      (cleanId && a.uid === cleanId) ||
      (cleanEmail && ((a.email && a.email.toLowerCase() === cleanEmail) || (a.gmail && a.gmail.toLowerCase() === cleanEmail)))
    );

    if (idx >= 0) {
      accounts[idx] = {
        ...accounts[idx],
        ...account,
        status: 'active',
        lastActiveAt: new Date().toISOString()
      };
    } else {
      accounts.push({
        ...account,
        status: 'active',
        lastActiveAt: new Date().toISOString()
      });
    }
    this.saveTeacherAccounts(accounts);

    const savedIdx = idx >= 0 ? idx : accounts.length - 1;

    // Also sync current active teacher session if relevant
    const session = this.getAuthSession();
    if (session.currentTeacher && (
      session.currentTeacher.id === account.id ||
      (account.uid && session.currentTeacher.uid === account.uid) ||
      (cleanEmail && (session.currentTeacher.email?.toLowerCase() === cleanEmail || session.currentTeacher.gmail?.toLowerCase() === cleanEmail))
    )) {
      session.currentTeacher = { ...accounts[savedIdx] };
      this.setAuthSession(session);
    }

    // Also sync with active TeacherInfo if relevant
    const activeTeacher = this.getTeacherInfo();
    if (
      activeTeacher.email === account.email ||
      activeTeacher.phone === account.phone ||
      (cleanEmail && activeTeacher.email?.toLowerCase() === cleanEmail)
    ) {
      this.saveTeacherInfo({
        ...activeTeacher,
        teacherName: account.name,
        phone: account.phone,
        email: account.email,
        designation: account.designation,
        avatar: account.avatar,
        photoUrl: account.photoUrl,
        dob: account.dob
      });
    }

    notifyMutation();
    return true;
  },

  deleteTeacherAccount(teacherId: string, isPermanent: boolean = false): boolean {
    const rawVal = localStorage.getItem(STORAGE_KEYS.TEACHER_ACCOUNTS);
    let allAccounts: TeacherAccount[] = [];
    try {
      if (rawVal) allAccounts = JSON.parse(rawVal);
    } catch (e) {}

    const target = allAccounts.find(a => a && (a.id === teacherId || a.uid === teacherId));
    const targetEmail = target?.email || target?.gmail;

    if (isPermanent) {
      this.addPermanentlyDeletedTeacherId(teacherId, targetEmail);
      if (target?.uid) this.addPermanentlyDeletedTeacherId(target.uid);
    } else {
      this.addTemporarilyDeletedTeacherId(teacherId, targetEmail);
      if (target?.uid) this.addTemporarilyDeletedTeacherId(target.uid);
    }

    const remaining = allAccounts.filter(a => a && a.id !== teacherId && a.uid !== teacherId);
    localStorage.setItem(STORAGE_KEYS.TEACHER_ACCOUNTS, JSON.stringify(remaining));

    if (isPermanent) {
      const session = this.getAuthSession();
      if (session.currentTeacher && (session.currentTeacher.id === teacherId || session.currentTeacher.uid === teacherId)) {
        this.setAuthSession({
          isLoggedIn: false,
          role: 'teacher',
          currentTeacher: null,
          currentAdmin: null
        });
      }
    }

    notifyMutation();
    return true;
  },

  addTeacherAccount(account: TeacherAccount): boolean {
    if (account) {
      if (this.isTeacherPermanentlyDeleted(account.id, account.email || account.gmail) || (account.uid && this.isTeacherPermanentlyDeleted(account.uid))) {
        return false;
      }
      this.removeTemporarilyDeletedTeacherId(account.id, account.email || account.gmail);
      if (account.uid) this.removeTemporarilyDeletedTeacherId(account.uid);
    }
    const accounts = this.getTeacherAccounts();
    const existing = accounts.find(
      a => (a.email && account.email && a.email.toLowerCase() === account.email.toLowerCase()) ||
           (a.phone && account.phone && a.phone === account.phone)
    );
    if (existing) {
      return false;
    }
    accounts.unshift({ ...account, status: 'active' });
    this.saveTeacherAccounts(accounts);
    notifyMutation();
    return true;
  },

  updateTeacherLastActive(teacherId: string) {
    const accounts = this.getTeacherAccounts();
    const idx = accounts.findIndex(a => a.id === teacherId);
    if (idx >= 0) {
      accounts[idx].lastActiveAt = new Date().toISOString();
      this.saveTeacherAccounts(accounts);
    }
  },

  // School Admin Storage Methods
  getSchoolAdmins(): SchoolAdminAccount[] {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.SCHOOL_ADMINS);
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          return parsed.map(a => ({
            ...a,
            schoolName: (a.schoolName?.toLowerCase().includes('sebast') || !a.schoolName)
              ? "St.Sebastian's Higher Secondary School"
              : a.schoolName,
            schoolCode: (a.schoolCode?.toUpperCase() === 'SSHSS@111213' || !a.schoolCode)
              ? 'SSHSS@111213'
              : a.schoolCode,
            adminName: (!a.adminName || a.adminName === 'School Administrator' || a.adminName === 'Principal / School Administrator')
              ? 'Principal'
              : a.adminName
          }));
        }
      }
      return [];
    } catch {
      return [];
    }
  },

  saveSchoolAdmins(admins: SchoolAdminAccount[]) {
    localStorage.setItem(STORAGE_KEYS.SCHOOL_ADMINS, JSON.stringify(admins));
    notifyMutation();
  },

  registerSchoolAdmin(admin: SchoolAdminAccount): boolean {
    const admins = this.getSchoolAdmins();
    const existing = admins.find(
      a => (a.schoolCode && a.schoolCode.toLowerCase() === admin.schoolCode.toLowerCase()) ||
           (a.schoolName && a.schoolName.toLowerCase() === admin.schoolName.toLowerCase()) ||
           (a.email && admin.email && a.email.toLowerCase() === admin.email.toLowerCase())
    );
    if (existing) {
      return false;
    }
    admins.push(admin);
    this.saveSchoolAdmins(admins);
    return true;
  },

  // Principal Broadcast Notifications
  getPrincipalBroadcasts(schoolCode?: string): PrincipalBroadcast[] {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.PRINCIPAL_BROADCASTS);
      let list: PrincipalBroadcast[] = [];
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          list = parsed;
        }
      }

      if (!schoolCode) return list;
      const cleanCode = schoolCode.trim().toLowerCase();
      return list.filter(b => !b.schoolCode || b.schoolCode.toLowerCase() === cleanCode);
    } catch {
      return [];
    }
  },

  savePrincipalBroadcasts(broadcasts: PrincipalBroadcast[]) {
    localStorage.setItem(STORAGE_KEYS.PRINCIPAL_BROADCASTS, JSON.stringify(broadcasts));
    notifyMutation();
  },

  getDismissedNotificationIds(teacherUid?: string, schoolCode?: string): string[] {
    try {
      const session = this.getAuthSession();
      const effectiveTeacherId = teacherUid || session.currentTeacher?.uid || session.currentTeacher?.id || 'default_teacher';
      const effectiveSchool = (schoolCode || session.currentTeacher?.schoolCode || this.getSchoolProfile().schoolCode || 'default_school').toUpperCase();
      const key = `DISMISSED_NOTIFICATIONS_${effectiveSchool}_${effectiveTeacherId}`;
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : [];
    } catch {
      return [];
    }
  },

  dismissNotificationForTeacher(notificationId: string, teacherUid?: string, schoolCode?: string) {
    try {
      const session = this.getAuthSession();
      const effectiveTeacherId = teacherUid || session.currentTeacher?.uid || session.currentTeacher?.id || 'default_teacher';
      const effectiveSchool = (schoolCode || session.currentTeacher?.schoolCode || this.getSchoolProfile().schoolCode || 'default_school').toUpperCase();
      const key = `DISMISSED_NOTIFICATIONS_${effectiveSchool}_${effectiveTeacherId}`;
      const dismissed = this.getDismissedNotificationIds(effectiveTeacherId, effectiveSchool);
      if (!dismissed.includes(notificationId)) {
        dismissed.push(notificationId);
        localStorage.setItem(key, JSON.stringify(dismissed));
      }
    } catch {}
  },

  isNotificationDismissedForTeacher(notificationId: string, teacherUid?: string, schoolCode?: string): boolean {
    const list = this.getDismissedNotificationIds(teacherUid, schoolCode);
    return list.includes(notificationId);
  },

  addPrincipalBroadcast(broadcast: PrincipalBroadcast) {
    const list = this.getPrincipalBroadcasts();
    const updated = [broadcast, ...list.filter(b => b.id !== broadcast.id)];
    this.savePrincipalBroadcasts(updated);

    const broadcastReminderId = `rem-broadcast-${broadcast.id}`;
    if (this.isNotificationDismissedForTeacher(broadcast.id) || this.isNotificationDismissedForTeacher(broadcastReminderId)) {
      return;
    }

    // Also push into Reminders so teacher dashboard and notification indicators update immediately
    const reminders = this.getReminders();
    const reminderEntry: Reminder = {
      id: broadcastReminderId,
      title: `📢 Principal Directive: ${broadcast.title}`,
      description: `${broadcast.message} [Target: ${broadcast.targetAudience || 'All Teachers'}]`,
      date: broadcast.date || new Date().toISOString().split('T')[0],
      time: broadcast.time || '09:30',
      repeat: 'none',
      category: broadcast.category === 'meeting' ? 'meeting' : broadcast.category === 'exam' ? 'exam' : 'general',
      isCompleted: false,
      createdAt: broadcast.createdAt || new Date().toISOString()
    };
    if (!reminders.some(r => r.id === reminderEntry.id)) {
      this.saveReminders([reminderEntry, ...reminders]);
    }
    notifyMutation();
  },

  deletePrincipalBroadcast(id: string) {
    const list = this.getPrincipalBroadcasts();
    const updated = list.filter(b => b.id !== id);
    this.savePrincipalBroadcasts(updated);
    const reminders = this.getReminders();
    const filteredReminders = reminders.filter(r => r.id !== `rem-broadcast-${id}` && r.id !== id);
    if (filteredReminders.length !== reminders.length) {
      this.saveReminders(filteredReminders);
    }
  },

  // Upcoming Teacher Birthdays Calculator
  getUpcomingTeacherBirthdays(
    teachersOrSchoolCode?: string | TeacherAccount[],
    withinDays: number = 60
  ): Array<{
    teacher: TeacherAccount;
    nextBirthdayStr: string;
    daysRemaining: number;
    isToday: boolean;
    isThisWeek: boolean;
    age: number;
    displayDate: string;
  }> {
    const teachers: TeacherAccount[] = Array.isArray(teachersOrSchoolCode)
      ? teachersOrSchoolCode
      : this.getTeachersBySchoolCode(typeof teachersOrSchoolCode === 'string' ? teachersOrSchoolCode : '');

    const now = new Date();
    const currentYear = now.getFullYear();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const results: Array<{
      teacher: TeacherAccount;
      nextBirthdayStr: string;
      daysRemaining: number;
      isToday: boolean;
      isThisWeek: boolean;
      age: number;
      displayDate: string;
    }> = [];

    teachers.forEach(teacher => {
      if (!teacher || !teacher.dob) return;
      const parsed = parseDateOfBirth(teacher.dob);
      if (!parsed) return;

      const birthYear = parsed.year;
      const birthMonth = parsed.month;
      const birthDay = parsed.day;

      // Birthday in current year
      let nextBirthday = new Date(currentYear, birthMonth, birthDay);

      // If already passed earlier this year, use next year
      if (nextBirthday.getTime() < todayMidnight.getTime()) {
        nextBirthday = new Date(currentYear + 1, birthMonth, birthDay);
      }

      const diffTime = nextBirthday.getTime() - todayMidnight.getTime();
      const daysRemaining = Math.round(diffTime / (1000 * 60 * 60 * 24));

      if (daysRemaining <= withinDays) {
        const isToday = daysRemaining === 0;
        const isThisWeek = daysRemaining > 0 && daysRemaining <= 7;
        let age = nextBirthday.getFullYear() - birthYear;
        const displayDate = nextBirthday.toLocaleDateString('en-IN', {
          month: 'short',
          day: 'numeric'
        });

        results.push({
          teacher,
          nextBirthdayStr: nextBirthday.toISOString().split('T')[0],
          daysRemaining,
          isToday,
          isThisWeek,
          age,
          displayDate
        });
      }
    });

    // Sort by nearest birthday first
    return results.sort((a, b) => a.daysRemaining - b.daysRemaining);
  },

  // Timetable Storage & Management Methods
  getTimetables(schoolCode?: string): TimetableSlot[] {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.TIMETABLES);
      let list: TimetableSlot[] = [];
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          list = parsed;
        }
      }

      if (!schoolCode) return list.filter(Boolean);
      const cleanCode = schoolCode.trim().toLowerCase();
      return list.filter(slot => slot && (!slot.schoolCode || slot.schoolCode.toLowerCase() === cleanCode));
    } catch {
      return [];
    }
  },

  saveTimetables(slots: TimetableSlot[]) {
    localStorage.setItem(STORAGE_KEYS.TIMETABLES, JSON.stringify(slots));
    notifyMutation();
  },

  saveTimetableSlot(slot: TimetableSlot) {
    const list = this.getTimetables();
    const idx = list.findIndex(s => s.id === slot.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...slot, updatedAt: new Date().toISOString() };
    } else {
      list.push({ ...slot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    this.saveTimetables(list);
  },

  deleteTimetableSlot(slotId: string): boolean {
    const list = this.getTimetables();
    const updated = list.filter(s => s.id !== slotId);
    this.saveTimetables(updated);
    return true;
  },

  // Timetable Period Timings & Saturday Preferences
  getTimetablePrefKey(schoolCode?: string, teacherId?: string): string {
    const cleanSchool = (schoolCode || 'default').trim().toUpperCase();
    const cleanTeacher = (teacherId || 'default').trim();
    return `${cleanSchool}::${cleanTeacher}`;
  },

  getAllTimetablePrefs(): Record<string, { periodTimings?: PeriodTimingConfig[]; includeSaturday?: boolean }> {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.TIMETABLE_PREFS);
      if (val) {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === 'object') return parsed;
      }
      return {};
    } catch {
      return {};
    }
  },

  saveAllTimetablePrefs(prefs: Record<string, { periodTimings?: PeriodTimingConfig[]; includeSaturday?: boolean }>) {
    localStorage.setItem(STORAGE_KEYS.TIMETABLE_PREFS, JSON.stringify(prefs));
    notifyMutation();
  },

  getPeriodTimings(schoolCode?: string, teacherId?: string): PeriodTimingConfig[] {
    const prefs = this.getAllTimetablePrefs();
    const key = this.getTimetablePrefKey(schoolCode, teacherId);
    const saved = prefs[key]?.periodTimings;
    if (Array.isArray(saved) && saved.length > 0) {
      return saved.slice(0, 6).map((p, idx) => ({
        ...DEFAULT_PERIOD_TIMINGS[idx],
        ...p,
        periodNumber: p.periodNumber || idx + 1,
        label: p.label || `Period ${idx + 1}`
      }));
    }
    return DEFAULT_PERIOD_TIMINGS.map(p => ({ ...p }));
  },

  savePeriodTimings(timings: PeriodTimingConfig[], schoolCode?: string, teacherId?: string) {
    const prefs = this.getAllTimetablePrefs();
    const key = this.getTimetablePrefKey(schoolCode, teacherId);
    const sanitized = timings.map((p, idx) => ({
      ...DEFAULT_PERIOD_TIMINGS[idx],
      ...p,
      periodNumber: p.periodNumber || idx + 1,
      label: (p.label || `Period ${idx + 1}`).trim()
    }));
    prefs[key] = {
      ...(prefs[key] || {}),
      periodTimings: sanitized
    };
    localStorage.setItem(STORAGE_KEYS.TIMETABLE_PREFS, JSON.stringify(prefs));

    // Also update existing timetable slots for this teacher so their start/end times stay synchronized
    if (teacherId) {
      const allSlots = this.getTimetables();
      let changed = false;
      const updatedSlots = allSlots.map(slot => {
        if (slot.teacherId === teacherId) {
          const matchingTiming = sanitized.find(t => t.periodNumber === slot.periodNumber);
          if (matchingTiming) {
            changed = true;
            return {
              ...slot,
              startTime: matchingTiming.startTime,
              endTime: matchingTiming.endTime,
              updatedAt: new Date().toISOString()
            };
          }
        }
        return slot;
      });
      if (changed) {
        localStorage.setItem(STORAGE_KEYS.TIMETABLES, JSON.stringify(updatedSlots));
      }
    }

    notifyMutation();
  },

  isSaturdayIncluded(schoolCode?: string, teacherId?: string): boolean {
    const prefs = this.getAllTimetablePrefs();
    const key = this.getTimetablePrefKey(schoolCode, teacherId);
    return Boolean(prefs[key]?.includeSaturday);
  },

  setSaturdayIncluded(included: boolean, schoolCode?: string, teacherId?: string) {
    const prefs = this.getAllTimetablePrefs();
    const key = this.getTimetablePrefKey(schoolCode, teacherId);
    prefs[key] = {
      ...(prefs[key] || {}),
      includeSaturday: included
    };
    this.saveAllTimetablePrefs(prefs);
  },

  getTeacherTimetable(teacherId: string, schoolCode?: string): TimetableSlot[] {
    const all = this.getTimetables(schoolCode);
    const cleanTeacherId = (teacherId || '').trim();
    return all.filter(s => s.teacherId === cleanTeacherId);
  },

  getClassTimetable(classNameOrId: string, schoolCode?: string): TimetableSlot[] {
    const all = this.getTimetables(schoolCode);
    const query = (classNameOrId || '').trim().toLowerCase();
    return all.filter(s => (s.classId && s.classId.toLowerCase() === query) || (s.className && s.className.toLowerCase() === query));
  },

  autoGenerateDefaultSchoolTimetable(schoolCode: string): TimetableSlot[] {
    const teachers = this.getTeachersBySchoolCode(schoolCode);
    const classes = this.getClassesList();
    const cleanCode = (schoolCode || '').trim().toUpperCase();
    const slots: TimetableSlot[] = [];

    if (classes.length === 0 || teachers.length === 0) {
      return [];
    }

    const days: TimetableDay[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const periods = DEFAULT_PERIOD_TIMINGS;

    const scienceSubjects = [
      { name: 'Physics', code: 'PHY', type: 'lecture' as const, room: 'Room 101' },
      { name: 'Chemistry', code: 'CHE', type: 'lecture' as const, room: 'Room 102' },
      { name: 'Mathematics', code: 'MAT', type: 'lecture' as const, room: 'Room 103' },
      { name: 'Biology', code: 'BIO', type: 'lecture' as const, room: 'Room 104' },
      { name: 'English', code: 'ENG', type: 'lecture' as const, room: 'Room 105' },
      { name: 'Computer Science', code: 'CS', type: 'lab' as const, room: 'CS Lab 1' }
    ];

    const commerceSubjects = [
      { name: 'Accountancy', code: 'ACC', type: 'lecture' as const, room: 'Room 201' },
      { name: 'Business Studies', code: 'BST', type: 'lecture' as const, room: 'Room 202' },
      { name: 'Economics', code: 'ECO', type: 'lecture' as const, room: 'Room 203' },
      { name: 'English', code: 'ENG', type: 'lecture' as const, room: 'Room 204' },
      { name: 'Computer Application', code: 'CA', type: 'lab' as const, room: 'IT Lab 2' },
      { name: 'Statistics / Mathematics', code: 'STAT', type: 'lecture' as const, room: 'Room 205' }
    ];

    const activeClasses = classes;
    const activeTeachers = teachers;

    activeClasses.forEach((cls, classIdx) => {
      const isCommerce = cls.stream?.toLowerCase().includes('comm') || cls.className?.toLowerCase().includes('comm');
      const subjectPool = isCommerce ? commerceSubjects : scienceSubjects;

      days.forEach((day, dayIdx) => {
        const maxPeriodsForDay = periods.length;

        for (let p = 0; p < maxPeriodsForDay; p++) {
          const timing = periods[p] || {
            periodNumber: p + 1,
            label: `Period ${p + 1}`,
            startTime: '09:30 AM',
            endTime: '10:15 AM'
          };

          const subjectIndex = (dayIdx * 2 + p + classIdx) % subjectPool.length;
          const subject = subjectPool[subjectIndex];
          const teacherIndex = (classIdx + p + dayIdx) % activeTeachers.length;
          const teacher = activeTeachers[teacherIndex];

          slots.push({
            id: `tt-${cls.id || 'c'}-${day.toLowerCase().substring(0, 3)}-p${p + 1}`,
            day,
            periodNumber: p + 1,
            startTime: timing.startTime,
            endTime: timing.endTime,
            subject: subject.name,
            subjectCode: subject.code,
            className: cls.className,
            classId: cls.id,
            teacherId: teacher.id,
            teacherName: teacher.name,
            teacherPhone: teacher.phone,
            roomNumber: subject.room,
            schoolCode: cleanCode,
            type: subject.type,
            notes: `${subject.name} curriculum session for ${cls.className}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      });
    });

    return slots;
  },

  generateTeacherStandardTimetable(teacher: TeacherAccount, assignedClass?: string, primarySubject?: string): TimetableSlot[] {
    const slots = this.getTimetables(teacher.schoolCode);
    const targetClass = assignedClass || teacher.assignedClass || this.getClassById(this.getActiveClassId(teacher.id, teacher.email, teacher))?.className || 'Classroom';
    const cleanSubject = primarySubject || teacher.primarySubject || (teacher.designation?.includes('Physics') ? 'Physics' : teacher.designation?.includes('Computer') ? 'Computer Science' : 'General Higher Secondary');
    const includeSat = this.isSaturdayIncluded(teacher.schoolCode, teacher.id);
    const days: TimetableDay[] = includeSat
      ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const teacherTimings = this.getPeriodTimings(teacher.schoolCode, teacher.id);

    const newSlots: TimetableSlot[] = [];
    days.forEach((day, dayIdx) => {
      const periodNum = (dayIdx % Math.min(4, teacherTimings.length)) + 1;
      const timing = teacherTimings[periodNum - 1] || teacherTimings[0];
      const slotId = `tt-${teacher.id}-${day.toLowerCase().substring(0, 3)}-p${periodNum}`;

      const existingIdx = slots.findIndex(s => s.teacherId === teacher.id && s.day === day && s.periodNumber === periodNum);
      const slotData: TimetableSlot = {
        id: slotId,
        day,
        periodNumber: periodNum,
        startTime: timing.startTime,
        endTime: timing.endTime,
        subject: cleanSubject,
        subjectCode: cleanSubject.substring(0, 3).toUpperCase(),
        className: targetClass,
        teacherId: teacher.id,
        teacherName: teacher.name,
        teacherPhone: teacher.phone,
        roomNumber: 'Room ' + (100 + periodNum),
        schoolCode: (teacher.schoolCode || 'SSHSS@111213').toUpperCase(),
        type: 'lecture',
        notes: `Scheduled class with ${targetClass}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (existingIdx >= 0) {
        slots[existingIdx] = slotData;
      } else {
        slots.push(slotData);
      }
      newSlots.push(slotData);
    });

    this.saveTimetables(slots);
    return newSlots;
  },

  // Verify School Admin Login with 4 required fields
  verifyAdminLogin(
    schoolGmail: string,
    schoolName: string,
    schoolCode: string,
    password: string,
    dob?: string,
    principalName?: string
  ): { success: boolean; admin?: SchoolAdminAccount; error?: string } {
    const qEmail = (schoolGmail || '').trim().toLowerCase();
    const qName = (schoolName || '').trim().toLowerCase();
    const qCode = (schoolCode || '').trim().toUpperCase();
    const pin = (password || '').trim();
    const qPrincipal = (principalName || '').trim().toLowerCase();
    const normalizeDob = (d?: string) => (d || '').trim().replace(/[/\s.-]/g, '');
    const qDobNorm = normalizeDob(dob);

    if (!qEmail || !qEmail.includes('@')) {
      return { success: false, error: 'Please enter a valid official School Gmail address.' };
    }
    if (!qName) {
      return { success: false, error: 'Please enter the official School Name.' };
    }
    if (!qCode) {
      return { success: false, error: 'Please enter your unique School Code (e.g. HSS-07142).' };
    }
    if (!pin) {
      return { success: false, error: 'Please enter your School Administrator Password / PIN.' };
    }
    if (!dob) {
      return { success: false, error: 'Please enter your date of birth.' };
    }
    if (!principalName || !principalName.trim()) {
      return { success: false, error: 'Please enter the Principal Name.' };
    }

    // Pre-authorized school admin credentials map (strict enforcement)
    const PRE_AUTHORIZED_ADMINS: Record<string, string> = {
      'gelwin72@gmail.com': 'elwin1234',
      'joicegeorge1910@gmail.com': 'joice1910',
      'lincythomas1911@gmail.com': 'lincy1911'
    };

    if (!PRE_AUTHORIZED_ADMINS[qEmail]) {
      return {
        success: false,
        error: 'Access Denied: Only pre-authorized School Admin Gmail addresses can enter the School Admin Panel.'
      };
    }

    if (qCode !== 'SSHSS@111213') {
      return {
        success: false,
        error: 'Access Denied: Invalid School Code. Must be SSHSS@111213.'
      };
    }

    if (pin !== PRE_AUTHORIZED_ADMINS[qEmail]) {
      return {
        success: false,
        error: `Access Denied: Incorrect password for ${qEmail}.`
      };
    }

    const adminNameDetermined = principalName.trim() || (
      qEmail.includes('gelwin') ? 'Gelwin' :
      qEmail.includes('joice') ? 'Joice George' : 'Lincy Thomas'
    );

    const verifiedAdmin: SchoolAdminAccount = {
      id: `admin-${qEmail.replace(/[^a-zA-Z0-9]/g, '_')}`,
      schoolName: schoolName.trim() || "St. Sebastian's Higher Secondary School Koodaranhi",
      schoolCode: 'SSHSS@111213',
      adminName: adminNameDetermined,
      designation: 'Principal & School Administrator',
      email: qEmail,
      phone: '',
      dob: dob ? dob.trim() : undefined,
      role: 'admin',
      createdAt: new Date().toISOString()
    };

    this.registerSchoolAdmin(verifiedAdmin);

    const prof = this.getSchoolProfile();
    this.saveSchoolProfile({
      ...prof,
      principalName: verifiedAdmin.adminName,
      schoolName: verifiedAdmin.schoolName,
      schoolCode: 'SSHSS@111213'
    });

    return { success: true, admin: verifiedAdmin };
  },

  // Export Complete School Data (JSON)
  exportCompleteSchoolData(schoolCode?: string): string {
    const schoolProfile = this.getSchoolProfile();
    const admins = this.getSchoolAdmins();
    const teachers = this.getTeachersBySchoolCode(schoolCode || schoolProfile.schoolCode);
    const classes = this.getClassesList();
    const broadcasts = this.getPrincipalBroadcasts(schoolCode || schoolProfile.schoolCode);
    const reminders = this.getReminders();
    const settings = this.getSettings();

    const classDataMap: Record<string, {
      students: Student[];
      attendance: AttendanceRecord[];
      exams: Exam[];
      examMarksMap: Record<string, ExamMarksRecord>;
    }> = {};

    classes.forEach(cls => {
      classDataMap[cls.id] = {
        students: this.getStudents(cls.id),
        attendance: this.getAttendance(cls.id),
        exams: this.getExams(cls.id),
        examMarksMap: this.getExamMarksMap(cls.id)
      };
    });

    const exportPayload = {
      appVersion: '2.5.0',
      exportType: 'COMPLETE_SCHOOL_ADMIN_BACKUP',
      exportedAt: new Date().toISOString(),
      schoolCode: schoolCode || schoolProfile.schoolCode,
      schoolProfile,
      schoolAdmins: admins,
      teachers,
      classesCatalog: classes,
      classDataMap,
      principalBroadcasts: broadcasts,
      reminders,
      settings,
      timetables: this.getTimetables(schoolCode || schoolProfile.schoolCode)
    };

    return JSON.stringify(exportPayload, null, 2);
  },

  // Import / Restore Complete School Data (JSON)
  importCompleteSchoolData(jsonData: string): {
    success: boolean;
    message: string;
    stats?: {
      teachersCount: number;
      classesCount: number;
      studentsCount: number;
      broadcastsCount: number;
    };
  } {
    try {
      const data = JSON.parse(jsonData);
      if (!data || typeof data !== 'object') {
        return { success: false, message: 'Invalid backup file format. Expected a valid JSON structure.' };
      }

      // Restore School Profile
      if (data.schoolProfile) {
        this.saveSchoolProfile(data.schoolProfile);
      }

      // Restore School Admins
      if (Array.isArray(data.schoolAdmins) && data.schoolAdmins.length > 0) {
        this.saveSchoolAdmins(data.schoolAdmins);
      }

      // Restore Teachers
      let teachersCount = 0;
      if (Array.isArray(data.teachers) && data.teachers.length > 0) {
        this.saveTeacherAccounts(data.teachers);
        teachersCount = data.teachers.length;
      }

      // Restore Classes Catalog
      let classesCount = 0;
      if (Array.isArray(data.classesCatalog) && data.classesCatalog.length > 0) {
        this.saveClassesList(data.classesCatalog);
        classesCount = data.classesCatalog.length;
      }

      // Restore Class-wise Data
      let totalStudentsCount = 0;
      if (data.classDataMap && typeof data.classDataMap === 'object') {
        Object.keys(data.classDataMap).forEach(classId => {
          const item = data.classDataMap[classId];
          if (item) {
            if (Array.isArray(item.students)) {
              this.saveStudents(item.students, classId);
              totalStudentsCount += item.students.length;
            }
            if (Array.isArray(item.attendance)) {
              this.saveAttendance(item.attendance, classId);
            }
            if (Array.isArray(item.exams)) {
              this.saveExams(item.exams, classId);
            }
            if (item.examMarksMap && typeof item.examMarksMap === 'object') {
              this.saveExamMarksMap(item.examMarksMap, classId);
            }
          }
        });
      }

      // Restore Principal Broadcasts
      let broadcastsCount = 0;
      if (Array.isArray(data.principalBroadcasts)) {
        this.savePrincipalBroadcasts(data.principalBroadcasts);
        broadcastsCount = data.principalBroadcasts.length;
      }

      // Restore Timetables
      if (Array.isArray(data.timetables) && data.timetables.length > 0) {
        this.saveTimetables(data.timetables);
      }

      // Restore Reminders & Settings
      if (Array.isArray(data.reminders)) {
        this.saveReminders(data.reminders);
      }
      if (data.settings) {
        this.saveSettings(data.settings);
      }

      notifyMutation();

      return {
        success: true,
        message: `Successfully imported school backup with ${classesCount} classes, ${teachersCount} teachers, and ${totalStudentsCount} students!`,
        stats: {
          teachersCount,
          classesCount,
          studentsCount: totalStudentsCount,
          broadcastsCount
        }
      };
    } catch (e: any) {
      return { success: false, message: `Failed to import school backup: ${e?.message || 'Invalid format'}` };
    }
  },

  getAuthSession(): AuthSession {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.AUTH_SESSION);
      if (!val) {
        return { isLoggedIn: false, role: 'teacher', currentTeacher: null, currentAdmin: null };
      }
      const parsed = JSON.parse(val);
      const PRE_AUTHORIZED_EMAILS = new Set([
        'gelwin72@gmail.com',
        'joicegeorge1910@gmail.com',
        'lincythomas1911@gmail.com'
      ]);

      const rawAdminEmail = (parsed.currentAdmin?.email || '').trim().toLowerCase();
      const rawAdminCode = (parsed.currentAdmin?.schoolCode || '').trim().toUpperCase();

      // Strictly block any admin session that does not belong to pre-authorized credentials
      if (parsed.role === 'admin') {
        if (!PRE_AUTHORIZED_EMAILS.has(rawAdminEmail) || rawAdminCode !== 'SSHSS@111213') {
          return { isLoggedIn: false, role: 'teacher', currentTeacher: null, currentAdmin: null };
        }
      }

      const currentAdmin = parsed.currentAdmin && PRE_AUTHORIZED_EMAILS.has(rawAdminEmail) && rawAdminCode === 'SSHSS@111213' ? {
        ...parsed.currentAdmin,
        schoolName: (parsed.currentAdmin.schoolName?.toLowerCase().includes('sebast') || !parsed.currentAdmin.schoolName)
          ? "St.Sebastian's Higher Secondary School"
          : parsed.currentAdmin.schoolName,
        schoolCode: 'SSHSS@111213',
        adminName: (!parsed.currentAdmin.adminName || parsed.currentAdmin.adminName === 'School Administrator' || parsed.currentAdmin.adminName === 'Principal / School Administrator')
          ? 'Principal'
          : parsed.currentAdmin.adminName
      } : null;
      return {
        isLoggedIn: Boolean(parsed.isLoggedIn),
        role: parsed.role || 'teacher',
        currentTeacher: parsed.currentTeacher || null,
        currentAdmin
      };
    } catch {
      return { isLoggedIn: false, role: 'teacher', currentTeacher: null, currentAdmin: null };
    }
  },

  setAuthSession(session: AuthSession) {
    localStorage.setItem(STORAGE_KEYS.AUTH_SESSION, JSON.stringify(session));
    notifyMutation();
  },

  logout() {
    localStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_CLASS_ID);
    notifyMutation();
  },

  logoutTeacher() {
    this.logout();
  },

  getAuditLogs(schoolCode?: string): AuditLogItem[] {
    try {
      const val = localStorage.getItem(STORAGE_KEYS.AUDIT_LOGS);
      if (!val) {
        return [];
      }
      return JSON.parse(val);
    } catch {
      return [];
    }
  },

  saveAuditLogs(logs: AuditLogItem[]) {
    localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS, JSON.stringify(logs.slice(-200)));
    notifyMutation();
  },

  addAuditLog(entry: Omit<AuditLogItem, 'id' | 'timestamp'>) {
    const current = this.getAuditLogs();
    const newEntry: AuditLogItem = {
      ...entry,
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString()
    };
    this.saveAuditLogs([newEntry, ...current]);

    let code = 'SSHSS@111213';
    const match = entry.target ? entry.target.match(/\[(.*?)\]/) : null;
    if (match && match[1]) {
      code = match[1];
    }
    import('./cloudSync').then(m => {
      m.CloudSync.saveAuditLogToSchool(code, newEntry).catch(() => {});
    }).catch(() => {});
  },

  clearAuditLogs() {
    localStorage.removeItem(STORAGE_KEYS.AUDIT_LOGS);
    localStorage.removeItem('hss_audit_logs_v1');
    localStorage.removeItem('hss_teacher_activities_' + (localStorage.getItem('hss_active_school_code') || 'SSHSS@111213'));
    notifyMutation();
  }
};
