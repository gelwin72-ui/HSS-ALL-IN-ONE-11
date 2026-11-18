import React, { useState, useEffect } from 'react';
import {
  GraduationCap,
  Sparkles,
  School,
  User,
  Mail,
  Phone,
  Lock,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  ShieldCheck,
  Award,
  Hash,
  Building2,
  KeyRound,
  Calendar,
  Cloud,
  RefreshCw,
  Laptop,
  Smartphone,
  Globe,
  BookOpen,
  Copy,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Database,
  Info,
  Layers,
  Check
} from 'lucide-react';
import { TeacherAccount, SchoolProfile, ClassInfo, ClassItem, TeacherInfo, SchoolAdminAccount } from '../types';
import { StorageService } from '../utils/storage';
import {
  auth,
  googleProvider,
  signInWithPopup,
  signOut,
  firestore,
  fsDoc,
  fsSetDoc,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateProfile
} from '../utils/firebase';
import { CloudSync } from '../utils/cloudSync';
import appLogo from '../assets/images/app_logo.png';

interface AuthScreenProps {
  onLoginSuccess: (teacher: TeacherAccount) => void;
  onAdminLoginSuccess?: (admin: SchoolAdminAccount) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onLoginSuccess, onAdminLoginSuccess }) => {
  const [mode, setMode] = useState<'signup' | 'login' | 'admin' | 'reset'>('signup');
  const [resetRole, setResetRole] = useState<'teacher' | 'admin'>('teacher');
  const [resetEmail, setResetEmail] = useState('');
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState<string>('');

  // Teacher Sign Up Form State
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPhone, setSignupPhone] = useState('');
  const [signupSchool, setSignupSchool] = useState('');
  const [signupSchoolCode, setSignupSchoolCode] = useState('');
  const [signupAcademicYear, setSignupAcademicYear] = useState('');
  const [signupSubject, setSignupSubject] = useState('Physics');
  const [customSubject, setCustomSubject] = useState('');
  const [signupDesignation, setSignupDesignation] = useState('');
  const [signupStandard, setSignupStandard] = useState('Class 12 (Plus Two)');
  const [customStandard, setCustomStandard] = useState('');
  const [signupStream, setSignupStream] = useState('Bio-Science');
  const [customStream, setCustomStream] = useState('');
  const [signupSection, setSignupSection] = useState('A');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupDob, setSignupDob] = useState('');
  const [signupIsClassTeacher, setSignupIsClassTeacher] = useState(true);

  // Teacher Login Form State
  const [loginSchoolCode, setLoginSchoolCode] = useState('');
  const [loginEmailOrPhone, setLoginEmailOrPhone] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginDob, setLoginDob] = useState('');
  const [loginAcademicYear, setLoginAcademicYear] = useState('');

  // Auto-fill saved teacher details (School Code, Academic Year, DOB) when email/phone entered
  useEffect(() => {
    const q = loginEmailOrPhone.trim().toLowerCase();
    if (q) {
      const accounts = StorageService.getTeacherAccounts();
      const match = accounts.find(a => 
        (a.email && a.email.toLowerCase() === q) ||
        (a.gmail && a.gmail.toLowerCase() === q) ||
        (a.phone && a.phone.trim() === q)
      );
      if (match) {
        if (match.academicYear && !loginAcademicYear) {
          setLoginAcademicYear(match.academicYear);
        }
        if (match.schoolCode && !loginSchoolCode) {
          setLoginSchoolCode(match.schoolCode);
        }
        if (match.dob && !loginDob) {
          setLoginDob(match.dob);
        }
      }
    }
  }, [loginEmailOrPhone]);

  // School Admin Login Form State
  const [adminGmail, setAdminGmail] = useState('');
  const [adminSchoolName, setAdminSchoolName] = useState('');
  const [adminSchoolCode, setAdminSchoolCode] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminDob, setAdminDob] = useState('');
  const [adminPrincipalName, setAdminPrincipalName] = useState('');
  const [adminDesignation, setAdminDesignation] = useState('Principal');

  // 1-Click Google Sign In (Firebase Auth + Multi-Device Firestore Sync)
  const handleGoogleSignIn = async () => {
    if (isLoading) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsLoading(true);
    setLoadingText('Connecting to Google and syncing multi-device data...');

    try {
      const result = await signInWithPopup(auth, googleProvider);
      const user = result.user;

      if (!user || !user.email) {
        throw new Error('Could not retrieve email from Google account.');
      }

      const cleanEmail = user.email.trim().toLowerCase();
      await CloudSync.fetchFromCloud(user);

      const accounts = StorageService.getTeacherAccounts();
      let activeTeacher = accounts.find(a => (a.email || '').toLowerCase() === cleanEmail);
      const currentSchool = StorageService.getSchoolProfile();
      const gCode = (activeTeacher?.schoolCode || currentSchool.schoolCode || 'SSHSS@111213').trim().toUpperCase();

      const isPermDeleted = await CloudSync.isTeacherPermanentlyDeletedForSchool(gCode, user.uid, cleanEmail);
      if (isPermDeleted) {
        await signOut(auth).catch(() => {});
        setErrorMsg('Access Denied: Your teacher account has been permanently removed from this school.');
        return;
      }

      const nowG = new Date().toISOString();
      if (!activeTeacher) {
        activeTeacher = {
          id: user.uid,
          uid: user.uid,
          name: user.displayName || 'Teacher',
          email: cleanEmail,
          gmail: cleanEmail,
          phone: '',
          schoolName: currentSchool.schoolName || "St. Sebastian's Higher Secondary School",
          schoolCode: gCode,
          designation: 'Higher Secondary Teacher',
          dob: '',
          assignedClass: 'Class 12 (Plus Two) Science A',
          createdAt: nowG,
          lastActiveAt: nowG
        };
        StorageService.registerTeacherAccount(activeTeacher);
      } else {
        activeTeacher = {
          ...activeTeacher,
          id: user.uid,
          uid: user.uid,
          email: cleanEmail,
          gmail: cleanEmail,
          schoolCode: gCode,
          lastActiveAt: nowG
        };
        delete activeTeacher.password;
      }

      const sanitizedTeacher: TeacherAccount = { ...activeTeacher };
      delete sanitizedTeacher.password;

      const updatedTeacher: TeacherInfo = {
        teacherName: sanitizedTeacher.name,
        email: cleanEmail,
        phone: sanitizedTeacher.phone,
        designation: sanitizedTeacher.designation
      };
      StorageService.saveTeacherInfo(updatedTeacher);

      StorageService.setAuthSession({
        isLoggedIn: true,
        role: 'teacher',
        currentTeacher: sanitizedTeacher,
        currentAdmin: null
      });

      // Write /users/{uid} FIRST so tenant Firestore rules resolve schoolCode cleanly
      if (firestore) {
        await fsSetDoc(fsDoc(firestore, `users/${user.uid}`), {
          userId: user.uid,
          uid: user.uid,
          email: cleanEmail,
          gmail: cleanEmail,
          role: 'teacher',
          schoolCode: gCode,
          schoolName: sanitizedTeacher.schoolName || "St. Sebastian's Higher Secondary School",
          displayName: sanitizedTeacher.name,
          name: sanitizedTeacher.name,
          phone: sanitizedTeacher.phone || '',
          dob: sanitizedTeacher.dob || '',
          status: 'active',
          teacherAccount: sanitizedTeacher,
          updatedAt: nowG
        }, { merge: true });
      }

      await CloudSync.saveTeacherToSchool(gCode, sanitizedTeacher);
      await CloudSync.recordGmailEntry(cleanEmail, {
        role: 'teacher',
        name: sanitizedTeacher.name,
        schoolCode: gCode,
        schoolName: sanitizedTeacher.schoolName,
        dob: sanitizedTeacher.dob,
        teacherId: user.uid,
        uid: user.uid,
        loginMethod: 'google'
      });

      CloudSync.setActiveSyncEmail(cleanEmail);
      await CloudSync.pushToCloud(user);
      CloudSync.startRealtimeSync(user);

      CloudSync.recordTeacherActivity(gCode, {
        teacherId: user.uid,
        teacherName: sanitizedTeacher.name,
        subject: sanitizedTeacher.subject || sanitizedTeacher.primarySubject || sanitizedTeacher.designation,
        assignedClass: sanitizedTeacher.assignedClass,
        activityType: 'login',
        description: `Teacher ${sanitizedTeacher.name} logged in via Google Auth`
      }).catch(() => {});

      setSuccessMsg(`Signed in with ${cleanEmail}! Synchronized across all your devices.`);
      onLoginSuccess(sanitizedTeacher);
    } catch (err: any) {
      console.warn('Google sign-in error:', err);
      const code = err?.code || '';
      if (code === 'auth/popup-closed-by-user') {
        setErrorMsg('Google sign-in was cancelled. Please try again.');
      } else if (code === 'auth/operation-not-allowed') {
        setErrorMsg('Google Sign-In is not enabled in Firebase Authentication Console yet.');
      } else {
        setErrorMsg(err?.message || 'Google sign-in failed. Please try again or use email login.');
      }
    } finally {
      setIsLoading(false);
      setLoadingText('');
    }
  };

  // 1. Teacher Sign Up Handler (Firebase Auth First + Immediate Firestore Persistence)
  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setErrorMsg(null);
    setSuccessMsg(null);

    const cleanEmail = signupEmail.trim().toLowerCase();
    if (!signupName.trim()) {
      setErrorMsg('Please enter your full name.');
      return;
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setErrorMsg('Please enter a valid Gmail / email address for Firebase Authentication.');
      return;
    }
    if (!signupSchoolCode.trim()) {
      setErrorMsg('Please enter your unique School Code (e.g. SSHSS@111213).');
      return;
    }
    if (!signupAcademicYear.trim()) {
      setErrorMsg('Please enter the Academic Year (e.g. 2026-27 or 2025-26).');
      return;
    }
    if (!signupDob) {
      setErrorMsg('Please enter your date of birth.');
      return;
    }
    if (!signupPassword || signupPassword.length < 6) {
      setErrorMsg('Please create a password of at least 6 characters (required by Firebase Authentication).');
      return;
    }

    const effectiveSubject = signupSubject.trim() || 'General';
    const effectiveStandard = signupStandard === 'Other' ? (customStandard.trim() || 'Class 12') : signupStandard;
    const effectiveStream = signupStream === 'Other' ? (customStream.trim() || 'General') : signupStream;
    const assignedClassName = `${effectiveStandard} ${effectiveStream} ${signupSection}`.trim();
    const cleanSchoolCode = (signupSchoolCode.trim() || 'SSHSS@111213').toUpperCase();
    const cleanSchoolName = signupSchool.trim() || "St. Sebastian's Higher Secondary School";
    const nowIso = new Date().toISOString();

    setIsLoading(true);
    setLoadingText('Creating your Firebase Authentication & Firestore teacher profile...');

    try {
      let userCred: any = null;
      let isNewUser = false;
      try {
        userCred = await createUserWithEmailAndPassword(auth, cleanEmail, signupPassword);
        isNewUser = true;
      } catch (createErr: any) {
        if (createErr?.code === 'auth/email-already-in-use') {
          try {
            userCred = await signInWithEmailAndPassword(auth, cleanEmail, signupPassword);
          } catch (signInErr: any) {
            if (signInErr?.code === 'auth/wrong-password' || signInErr?.code === 'auth/invalid-credential') {
              throw new Error('This email is already registered with a different password. Please use the Teacher Login tab or reset your password.');
            }
            throw signInErr;
          }
        } else {
          throw createErr;
        }
      }

      const authUser = userCred?.user;
      if (!authUser?.uid) {
        throw new Error('Firebase Authentication did not return a valid user ID.');
      }

      const firebaseUid = authUser.uid;
      if (isNewUser) {
        await updateProfile(authUser, { displayName: signupName.trim() }).catch(() => {});
        sendEmailVerification(authUser).catch(() => {});
      }

      const isPermDeleted = await CloudSync.isTeacherPermanentlyDeletedForSchool(cleanSchoolCode, firebaseUid, cleanEmail);
      if (isPermDeleted) {
        await signOut(auth).catch(() => {});
        setErrorMsg('Access Denied: This teacher account has been permanently removed from this school.');
        return;
      }

      const initialClassId = 'class-' + Date.now();
      const newAccount: TeacherAccount = {
        id: firebaseUid,
        uid: firebaseUid,
        name: signupName.trim(),
        email: cleanEmail,
        gmail: cleanEmail,
        status: 'active',
        academicYear: signupAcademicYear.trim(),
        phone: signupPhone.trim(),
        schoolName: cleanSchoolName,
        schoolCode: cleanSchoolCode,
        subject: effectiveSubject,
        primarySubject: effectiveSubject,
        standard: effectiveStandard,
        stream: effectiveStream,
        section: signupSection,
        assignedClass: assignedClassName,
        designation: signupDesignation.trim() || `${effectiveSubject} Teacher`,
        dob: signupDob.trim(),
        createdAt: nowIso,
        lastActiveAt: nowIso
      };

      let initialClass: ClassItem | null = null;
      if (effectiveStandard && signupSection) {
        initialClass = {
          id: initialClassId,
          className: assignedClassName,
          standard: effectiveStandard,
          stream: effectiveStream,
          section: signupSection,
          academicYear: signupAcademicYear.trim() || '2026-2027',
          classStrength: 0,
          teacherId: firebaseUid,
          teacherUid: firebaseUid,
          teacherName: newAccount.name,
          schoolCode: cleanSchoolCode,
          isTeacherCreated: true,
          createdByTeacherId: firebaseUid,
          createdByTeacherEmail: cleanEmail,
          createdAt: nowIso
        };
        const savedClass = StorageService.addNewClass(initialClass, []);
        initialClass = savedClass;
        StorageService.setActiveClassId(savedClass.id);
        newAccount.teacherClassId = savedClass.id;
        newAccount.assignedClass = savedClass.className;
      }

      const existingList = StorageService.getTeacherAccounts();
      const existingIdx = existingList.findIndex(a => a.id === firebaseUid || (a.email || '').toLowerCase() === cleanEmail);
      if (existingIdx >= 0) {
        existingList[existingIdx] = { ...existingList[existingIdx], ...newAccount };
        StorageService.saveTeacherAccounts(existingList);
      } else {
        StorageService.registerTeacherAccount(newAccount);
      }

      StorageService.removeTemporarilyDeletedTeacherId(firebaseUid, cleanEmail);

      const currentSchool = StorageService.getSchoolProfile();
      StorageService.saveSchoolProfile({
        ...currentSchool,
        schoolName: newAccount.schoolName || currentSchool.schoolName,
        schoolCode: newAccount.schoolCode
      });

      StorageService.saveTeacherInfo({
        teacherName: newAccount.name,
        email: cleanEmail,
        phone: newAccount.phone,
        designation: newAccount.designation,
        academicYear: signupAcademicYear.trim()
      });

      if (newAccount.teacherClassId) {
        const targetCid = newAccount.teacherClassId;
        const currentClass = StorageService.getClassInfo(targetCid);
        StorageService.saveClassInfo({
          ...currentClass,
          id: targetCid,
          standard: effectiveStandard,
          stream: effectiveStream,
          section: signupSection,
          academicYear: signupAcademicYear.trim(),
          className: assignedClassName
        }, targetCid);
      }

      StorageService.setAuthSession({
        isLoggedIn: true,
        role: 'teacher',
        currentTeacher: newAccount,
        currentAdmin: null
      });

      // Write /users/{uid} FIRST so tenant Firestore rules authorize all school writes
      if (firestore) {
        await fsSetDoc(fsDoc(firestore, `users/${firebaseUid}`), {
          userId: firebaseUid,
          uid: firebaseUid,
          email: cleanEmail,
          gmail: cleanEmail,
          role: 'teacher',
          schoolCode: cleanSchoolCode,
          schoolName: cleanSchoolName,
          displayName: newAccount.name,
          name: newAccount.name,
          phone: newAccount.phone,
          dob: newAccount.dob || '',
          status: 'active',
          teacherAccount: newAccount,
          createdAt: nowIso,
          updatedAt: nowIso
        }, { merge: true });
      }

      await CloudSync.saveTeacherToSchool(cleanSchoolCode, newAccount);
      if (initialClass) {
        await CloudSync.saveClassToSchool(cleanSchoolCode, initialClass, []);
      }

      await CloudSync.recordGmailEntry(cleanEmail, {
        role: 'teacher',
        name: newAccount.name,
        schoolCode: cleanSchoolCode,
        schoolName: cleanSchoolName,
        loginMethod: 'email',
        dob: signupDob.trim(),
        dateOfBirth: signupDob.trim(),
        teacherId: firebaseUid,
        uid: firebaseUid,
        phone: signupPhone.trim(),
        subject: effectiveSubject,
        assignedClass: assignedClassName
      });

      CloudSync.setActiveSyncEmail(cleanEmail);
      await CloudSync.pushToCloud(authUser);
      CloudSync.startRealtimeSync(authUser);

      // Non-blocking notifications & activity logs after core persistence succeeds
      fetch('/api/send-teacher-registration-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teacherName: newAccount.name,
          teacherEmail: cleanEmail,
          teacherId: newAccount.id,
          schoolCode: cleanSchoolCode,
          schoolName: cleanSchoolName,
          registrationTime: nowIso
        })
      }).catch(() => {});

      CloudSync.recordTeacherActivity(cleanSchoolCode, {
        teacherId: newAccount.id,
        teacherName: newAccount.name,
        subject: effectiveSubject,
        assignedClass: assignedClassName,
        activityType: 'signup',
        description: `Registered as teacher for ${assignedClassName} (${effectiveSubject})`
      }).catch(() => {});

      CloudSync.recordLoginActivity(cleanSchoolCode, {
        email: cleanEmail,
        accessMethod: 'Teacher Sign-Up',
        role: 'teacher',
        success: true,
        details: `Teacher signed up successfully via Firebase Auth: ${cleanEmail}`
      }).catch(() => {});

      setSuccessMsg(`Welcome, ${newAccount.name}! Account created and synced.`);
      onLoginSuccess(newAccount);
    } catch (err: any) {
      console.warn('Teacher signup error:', err);
      const code = err?.code || '';
      if (code === 'auth/weak-password') {
        setErrorMsg('Password must be at least 6 characters long.');
      } else if (code === 'auth/invalid-email') {
        setErrorMsg('Please enter a valid email address.');
      } else if (code === 'auth/operation-not-allowed') {
        setErrorMsg('Email/Password authentication is not enabled yet in Firebase Console (Authentication > Sign-in method).');
      } else if (code === 'auth/too-many-requests') {
        setErrorMsg('Too many attempts. Please wait a moment and try again.');
      } else {
        setErrorMsg(err?.message || 'Failed to create teacher account. Please try again.');
      }
    } finally {
      setIsLoading(false);
      setLoadingText('');
    }
  };

  // 2. Teacher Login Handler (Strict Firebase Auth + Firestore Restoration)
  const handleTeacherLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setErrorMsg(null);
    setSuccessMsg(null);

    const cleanQuery = loginEmailOrPhone.trim().toLowerCase();
    const cleanSchoolCode = (loginSchoolCode || 'SSHSS@111213').trim().toUpperCase();
    const normalizeDob = (d?: string) => (d || '').trim().replace(/[/\s.-]/g, '');

    if (!cleanQuery) {
      setErrorMsg('Please enter your registered Gmail / email address.');
      return;
    }
    if (!loginPassword) {
      setErrorMsg('Please enter your password.');
      return;
    }

    const localAccounts = StorageService.getTeacherAccounts();
    const localCandidate = localAccounts.find(
      a =>
        (a.gmail && a.gmail.toLowerCase() === cleanQuery) ||
        (a.email && a.email.toLowerCase() === cleanQuery) ||
        a.phone === cleanQuery ||
        a.name.toLowerCase() === cleanQuery
    );

    const resolvedEmail = cleanQuery.includes('@')
      ? cleanQuery
      : (localCandidate?.email || localCandidate?.gmail || '').trim().toLowerCase();

    if (!resolvedEmail || !resolvedEmail.includes('@')) {
      setErrorMsg('Please sign in with your registered Gmail / email address.');
      return;
    }

    setIsLoading(true);
    setLoadingText('Verifying credentials with Firebase Authentication...');

    try {
      const cred = await signInWithEmailAndPassword(auth, resolvedEmail, loginPassword);
      const authUser = cred.user;
      if (!authUser?.uid) {
        throw new Error('Firebase Authentication did not return a user ID.');
      }
      const realUid = authUser.uid;

      const isPermDeleted = await CloudSync.isTeacherPermanentlyDeletedForSchool(cleanSchoolCode, realUid, resolvedEmail);
      if (isPermDeleted) {
        await signOut(auth).catch(() => {});
        setErrorMsg('Access Denied: Your teacher account has been permanently removed from this school.');
        return;
      }

      setLoadingText('Loading your Firestore classroom profile...');
      await CloudSync.fetchFromCloud(authUser);

      const [credResult, cloudFull, restored] = await Promise.all([
        CloudSync.fetchTeacherCredential(resolvedEmail, cleanSchoolCode).catch(() => null),
        CloudSync.fetchCompleteUserCloudData(realUid, resolvedEmail, cleanSchoolCode).catch(() => null),
        CloudSync.restoreTeacherClassroom(realUid, resolvedEmail, cleanSchoolCode).catch(() => null)
      ]);

      if (credResult && (credResult as any).found && (credResult as any).reason === 'status_inactive') {
        await signOut(auth).catch(() => {});
        setErrorMsg('Access Denied: Your teacher account status is inactive or suspended.');
        return;
      }

      const hydratedAccounts = StorageService.getTeacherAccounts();
      let match: TeacherAccount | null =
        (credResult && (credResult as any).teacher) ||
        cloudFull?.teacherAccount ||
        hydratedAccounts.find(a => a.id === realUid || (a.email || '').toLowerCase() === resolvedEmail) ||
        localCandidate ||
        null;

      if (!match) {
        match = {
          id: realUid,
          uid: realUid,
          name: authUser.displayName || resolvedEmail.split('@')[0],
          email: resolvedEmail,
          gmail: resolvedEmail,
          phone: '',
          schoolName: StorageService.getSchoolProfile().schoolName || "St. Sebastian's Higher Secondary School",
          schoolCode: cleanSchoolCode,
          designation: 'Class Teacher',
          dob: loginDob ? loginDob.trim() : '',
          academicYear: loginAcademicYear.trim() || '2026-2027',
          createdAt: new Date().toISOString()
        };
      }

      if (loginDob && match.dob && normalizeDob(match.dob) !== normalizeDob(loginDob) && match.dob !== loginDob.trim()) {
        await signOut(auth).catch(() => {});
        setErrorMsg('Incorrect date of birth. Please try again.');
        return;
      }

      const nowIso = new Date().toISOString();
      match = {
        ...match,
        id: realUid,
        uid: realUid,
        email: resolvedEmail,
        gmail: resolvedEmail,
        status: 'active',
        schoolCode: cleanSchoolCode,
        dob: loginDob ? loginDob.trim() : (match.dob || ''),
        academicYear: loginAcademicYear.trim() || match.academicYear || '2026-2027',
        lastActiveAt: nowIso
      };
      delete match.password;

      if (restored?.activeClassId) {
        match.teacherClassId = restored.activeClassId;
        if (restored.classItem?.className) {
          match.assignedClass = restored.classItem.className;
        }
        StorageService.setActiveClassId(restored.activeClassId);
      } else {
        const teacherClasses = StorageService.getClassesByTeacher(realUid, resolvedEmail, match);
        if (teacherClasses.length > 0) {
          const originalClass = teacherClasses[0];
          match.teacherClassId = originalClass.id;
          match.assignedClass = originalClass.className;
          StorageService.setActiveClassId(originalClass.id);
        }
      }

      StorageService.removeDeletedTeacherId(match.id, resolvedEmail);
      StorageService.removeTemporarilyDeletedTeacherId(match.id, resolvedEmail);

      const allAccounts = StorageService.getTeacherAccounts();
      const existingIdx = allAccounts.findIndex(a => a.id === realUid || (a.email || '').toLowerCase() === resolvedEmail);
      if (existingIdx >= 0) {
        allAccounts[existingIdx] = match;
      } else {
        allAccounts.push(match);
      }
      StorageService.saveTeacherAccounts(allAccounts);
      StorageService.updateTeacherLastActive(match.id);

      StorageService.saveTeacherInfo({
        teacherName: match.name,
        email: resolvedEmail,
        phone: match.phone,
        designation: match.designation,
        academicYear: match.academicYear
      });

      StorageService.setAuthSession({
        isLoggedIn: true,
        role: 'teacher',
        currentTeacher: match,
        currentAdmin: null
      });

      if (firestore) {
        await fsSetDoc(fsDoc(firestore, `users/${realUid}`), {
          userId: realUid,
          uid: realUid,
          email: resolvedEmail,
          gmail: resolvedEmail,
          role: 'teacher',
          schoolCode: cleanSchoolCode,
          schoolName: match.schoolName || "St. Sebastian's Higher Secondary School",
          displayName: match.name,
          name: match.name,
          phone: match.phone || '',
          dob: match.dob || '',
          status: 'active',
          teacherAccount: match,
          updatedAt: nowIso
        }, { merge: true });
      }

      await CloudSync.saveTeacherToSchool(cleanSchoolCode, match);
      await CloudSync.recordGmailEntry(resolvedEmail, {
        role: 'teacher',
        name: match.name,
        schoolCode: cleanSchoolCode,
        schoolName: match.schoolName,
        loginMethod: 'email',
        dob: match.dob || '',
        teacherId: realUid,
        uid: realUid,
        phone: match.phone,
        subject: match.subject || match.primarySubject,
        assignedClass: match.assignedClass
      });

      CloudSync.setActiveSyncEmail(resolvedEmail);
      await CloudSync.pushToCloud(authUser);
      CloudSync.startRealtimeSync(authUser);

      CloudSync.recordTeacherActivity(cleanSchoolCode, {
        teacherId: match.id,
        teacherName: match.name,
        subject: match.subject || match.primarySubject || match.designation,
        assignedClass: match.assignedClass,
        activityType: 'login',
        description: `Teacher ${match.name} logged into School Portal`
      }).catch(() => {});

      CloudSync.recordLoginActivity(cleanSchoolCode, {
        email: resolvedEmail,
        accessMethod: 'Teacher Login',
        role: 'teacher',
        success: true,
        details: `Teacher logged in successfully via Firebase Auth: ${resolvedEmail}`
      }).catch(() => {});

      setSuccessMsg(`Welcome back, ${match.name}!`);
      onLoginSuccess(match);
    } catch (err: any) {
      console.warn('Teacher login error:', err);
      const code = err?.code || '';
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
        setErrorMsg('Invalid email or password. Please verify your credentials or create an account in Teacher Sign Up.');
      } else if (code === 'auth/too-many-requests') {
        setErrorMsg('Too many failed sign-in attempts. Please wait a few minutes and try again.');
      } else if (code === 'auth/operation-not-allowed') {
        setErrorMsg('Email/Password sign-in is not enabled yet in Firebase Authentication Console.');
      } else {
        setErrorMsg(err?.message || 'Failed to sign in. Please check your credentials.');
      }
    } finally {
      setIsLoading(false);
      setLoadingText('');
    }
  };

  // 3. School Admin Login Handler (Pre-Authorized Verification + Real Firebase Auth + Admin Bootstrap)
  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setErrorMsg(null);
    setSuccessMsg(null);

    const cleanGmail = adminGmail.trim().toLowerCase();
    const cleanSchoolCode = adminSchoolCode.trim().toUpperCase();

    if (!cleanGmail || !cleanGmail.includes('@')) {
      setErrorMsg('Please enter a valid School Gmail address.');
      return;
    }
    if (!cleanSchoolCode) {
      setErrorMsg('Please enter your unique School Code.');
      return;
    }
    if (!adminPassword) {
      setErrorMsg('Please enter your School Admin Password.');
      return;
    }

    const PRE_AUTHORIZED_CREDENTIALS: Record<string, { password: string; schoolCode: string; defaultName: string }> = {
      'gelwin72@gmail.com': { password: 'elwin1234', schoolCode: 'SSHSS@111213', defaultName: 'Gelwin' },
      'joicegeorge1910@gmail.com': { password: 'joice1910', schoolCode: 'SSHSS@111213', defaultName: 'Joice George' },
      'lincythomas1911@gmail.com': { password: 'lincy1911', schoolCode: 'SSHSS@111213', defaultName: 'Lincy Thomas' }
    };

    const authorizedAdmin = PRE_AUTHORIZED_CREDENTIALS[cleanGmail];

    if (!authorizedAdmin) {
      setErrorMsg('Access Denied: Only authorized school admin Gmail addresses (joicegeorge1910@gmail.com, gelwin72@gmail.com or lincythomas1911@gmail.com) can access the School Admin Panel.');
      return;
    }

    if (cleanSchoolCode !== authorizedAdmin.schoolCode) {
      setErrorMsg(`Invalid School Code. Must be ${authorizedAdmin.schoolCode}.`);
      return;
    }

    if (adminPassword !== authorizedAdmin.password) {
      setErrorMsg(`Incorrect password for ${cleanGmail}. Please enter the correct password.`);
      return;
    }

    setIsLoading(true);
    setLoadingText('Authenticating School Admin with Firebase...');

    try {
      let cred: any = null;
      try {
        cred = await signInWithEmailAndPassword(auth, cleanGmail, adminPassword);
      } catch (authErr: any) {
        if (authErr?.code === 'auth/user-not-found' || authErr?.code === 'auth/invalid-credential') {
          try {
            cred = await createUserWithEmailAndPassword(auth, cleanGmail, adminPassword);
            if (cred?.user) {
              await updateProfile(cred.user, { displayName: authorizedAdmin.defaultName }).catch(() => {});
              sendEmailVerification(cred.user).catch(() => {});
            }
          } catch (createErr: any) {
            if (createErr?.code === 'auth/email-already-in-use') {
              throw new Error('Firebase Auth password differs from the default admin PIN. Please use Forgot Password or enter your updated Firebase password.');
            }
            throw createErr;
          }
        } else {
          throw authErr;
        }
      }

      const authUser = cred?.user;
      if (!authUser?.uid) {
        throw new Error('Firebase Authentication failed for School Admin.');
      }

      const authUid = authUser.uid;
      const adminNameDetermined = adminPrincipalName.trim() || adminDesignation || authorizedAdmin.defaultName;

      const adminAccount: SchoolAdminAccount = {
        id: authUid,
        adminName: adminNameDetermined,
        schoolName: adminSchoolName.trim() || "St. Sebastian's Higher Secondary School Koodaranhi",
        schoolCode: cleanSchoolCode,
        email: cleanGmail,
        phone: '',
        dob: adminDob ? adminDob.trim() : undefined,
        designation: adminDesignation || 'Head of School',
        role: 'admin',
        createdAt: new Date().toISOString()
      };

      const adminSyncRes = await CloudSync.verifyAndSyncSchoolAdmin(
        authUid,
        cleanGmail,
        cleanSchoolCode,
        adminDesignation
      );

      if (!adminSyncRes.authorized) {
        await signOut(auth).catch(() => {});
        setErrorMsg(adminSyncRes.reason || 'Access Denied: Failed to verify School Admin privileges.');
        return;
      }

      const currentSchool = StorageService.getSchoolProfile();
      StorageService.saveSchoolProfile({
        ...currentSchool,
        schoolCode: cleanSchoolCode,
        schoolName: adminAccount.schoolName,
        principalName: adminAccount.adminName,
        schoolEmail: cleanGmail
      });

      StorageService.setAuthSession({
        isLoggedIn: true,
        role: 'admin',
        currentTeacher: null,
        currentAdmin: adminAccount
      });

      CloudSync.setActiveSyncEmail(cleanGmail);
      await CloudSync.recordGmailEntry(cleanGmail, {
        role: 'admin',
        name: adminAccount.adminName,
        schoolCode: cleanSchoolCode,
        schoolName: adminAccount.schoolName,
        loginMethod: 'email',
        designation: adminDesignation || 'Head of School',
        uid: authUid
      }).catch(() => {});

      await CloudSync.pushToCloud(authUser);
      CloudSync.startRealtimeSync(authUser);

      CloudSync.recordLoginActivity(cleanSchoolCode, {
        email: cleanGmail,
        accessMethod: 'School Admin Panel',
        role: 'admin',
        success: true,
        details: `Authorized School Admin logged in: ${cleanGmail}`
      }).catch(() => {});

      setSuccessMsg(`Welcome, ${adminAccount.adminName}! Access granted to School Admin Panel.`);
      if (onAdminLoginSuccess) {
        onAdminLoginSuccess(adminAccount);
      }
    } catch (err: any) {
      console.warn('Admin login error:', err);
      const code = err?.code || '';
      if (code === 'auth/operation-not-allowed') {
        setErrorMsg('Email/Password sign-in is not enabled yet in Firebase Authentication Console.');
      } else {
        setErrorMsg(err?.message || 'School Admin authentication failed.');
      }
    } finally {
      setIsLoading(false);
      setLoadingText('');
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const cleanEmail = resetEmail.trim().toLowerCase();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      setErrorMsg('Please enter a valid registered email address.');
      return;
    }

    setIsLoading(true);
    setLoadingText('Sending secure password reset email via Firebase Authentication...');

    try {
      if (!auth) {
        throw new Error('Firebase Authentication is not initialized.');
      }

      let backendDispatched = false;
      try {
        const resp = await fetch('/api/send-password-reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: cleanEmail })
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.success) {
            backendDispatched = true;
          }
        }
      } catch {
        // Fall back seamlessly to client-side Firebase Auth
      }

      if (!backendDispatched) {
        // Send password reset email directly through Firebase Authentication
        // This sends an encrypted one-time reset link directly to the user's inbox
        // without storing, exposing, or modifying passwords in the database.
        await sendPasswordResetEmail(auth, cleanEmail);
      }

      setSuccessMsg(
        `A secure password reset link has been dispatched to ${cleanEmail}. Please check your inbox (and spam/junk folder) and click the link to choose your new password. Once updated, you can return here to log in.`
      );
    } catch (err: any) {
      console.warn('Password reset error:', err);
      const code = err?.code || '';
      if (code === 'auth/user-not-found') {
        setErrorMsg('No registered account was found for this email address. Please check your spelling or sign up.');
      } else if (code === 'auth/invalid-email') {
        setErrorMsg('The email address entered is not valid.');
      } else if (code === 'auth/too-many-requests') {
        setErrorMsg('Too many requests have been made. Please wait a few moments before trying again.');
      } else if (code === 'auth/network-request-failed') {
        setErrorMsg('Network error. Please check your internet connection.');
      } else {
        setErrorMsg(err?.message || 'Password reset request failed. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0F1115] text-slate-100 flex flex-col justify-center items-center px-3.5 sm:px-4 py-8 relative overflow-hidden selection:bg-purple-500 selection:text-white">
      {/* Ambient background glows */}
      <div className="absolute top-10 left-1/2 -translate-x-1/2 w-96 h-96 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-80 h-80 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none" />

      {/* Center Container */}
      <div className="w-full max-w-xl z-10 space-y-5 animate-fade-in">
        {/* App Logo & Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-2 rounded-3xl bg-[#1A1C23] shadow-2xl shadow-purple-600/20 ring-4 ring-purple-500/10 mb-1 w-20 h-20 overflow-hidden">
            <img
              src={appLogo}
              alt="HSS ALL IN ONE Logo"
              className="w-14 h-14 object-contain"
              onError={(e) => {
                e.currentTarget.src = '/logo.png';
              }}
            />
          </div>

          <div className="flex items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-purple-500/10 text-purple-300 border border-purple-500/20">
              <Sparkles className="w-3.5 h-3.5" /> Higher Secondary Education Portal
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-white">
            HSS ALL IN ONE
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 max-w-md mx-auto">
            Smart School & Class Management System for Higher Secondary Teachers & Administration
          </p>
        </div>

        {/* Multi-Device Sync Feature Announcement Badge */}
        <div className="p-3.5 rounded-2xl bg-gradient-to-r from-purple-900/30 via-indigo-900/30 to-blue-900/30 border border-purple-500/30 shadow-lg flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-purple-600/30 text-purple-300 shrink-0 border border-purple-500/40">
              <Cloud className="w-4.5 h-4.5 animate-pulse" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                <span>Multi-Device Instant Sync Active</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  REAL-TIME
                </span>
              </h4>
              <p className="text-[11px] text-slate-300/90 leading-tight mt-0.5">
                Log in with the same email on any phone, tablet, or PC to access and edit your school records seamlessly.
              </p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 text-slate-400 shrink-0">
            <Smartphone className="w-4 h-4 text-purple-400" />
            <span className="text-[10px] font-bold">⇄</span>
            <Laptop className="w-4 h-4 text-indigo-400" />
          </div>
        </div>



        {/* 3 Navigation Mode Toggle Tabs */}
        <div className="grid grid-cols-3 rounded-2xl bg-[#1A1C23] p-1.5 border border-[#2D3139] shadow-lg gap-1">
          <button
            type="button"
            id="tab-teacher-signup"
            onClick={() => {
              setMode('signup');
              setErrorMsg(null);
            }}
            className={`py-2 sm:py-2.5 px-1 rounded-xl text-[11px] sm:text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              mode === 'signup'
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <User className="w-3.5 h-3.5 shrink-0 hidden sm:inline" />
            <span>TEACHER SIGN UP</span>
          </button>

          <button
            type="button"
            id="tab-teacher-login"
            onClick={() => {
              setMode('login');
              setErrorMsg(null);
            }}
            className={`py-2 sm:py-2.5 px-1 rounded-xl text-[11px] sm:text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              mode === 'login'
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Lock className="w-3.5 h-3.5 shrink-0 hidden sm:inline" />
            <span>TEACHER LOGIN</span>
          </button>

          <button
            type="button"
            id="tab-admin-login"
            onClick={() => {
              setMode('admin');
              setErrorMsg(null);
            }}
            className={`py-2 sm:py-2.5 px-1 rounded-xl text-[11px] sm:text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              mode === 'admin'
                ? 'bg-gradient-to-r from-amber-600 to-rose-600 text-white shadow-md'
                : 'text-slate-400 hover:text-amber-400'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-amber-300" />
            <span>SCHOOL ADMIN</span>
          </button>
        </div>

        {/* Loading Spinner Alert */}
        {isLoading && (
          <div className="p-4 rounded-2xl bg-purple-950/70 border border-purple-500/40 text-purple-200 flex items-center gap-3 text-xs sm:text-sm animate-fade-in shadow-lg">
            <RefreshCw className="w-5 h-5 text-purple-400 animate-spin shrink-0" />
            <span className="font-semibold">{loadingText || 'Syncing data...'}</span>
          </div>

        )}
        {/* Feedback Alerts */}
        {errorMsg && (
          <div className="p-4 rounded-2xl bg-rose-950/60 border border-rose-500/40 text-rose-300 flex items-center gap-3 text-xs sm:text-sm animate-fade-in shadow-lg">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
            <span>{errorMsg}</span>
          </div>

        )}
        {successMsg && (
          <div className="p-4 rounded-2xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 flex items-center gap-3 text-xs sm:text-sm animate-fade-in shadow-lg">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            <span>{successMsg}</span>
          </div>

        )}
        {/* Main Form Card */}
        <div className="rounded-3xl bg-[#1A1C23] border border-[#2D3139] p-5 sm:p-7 shadow-2xl space-y-5">
          {/* 1. TEACHER SIGN UP FORM */}
          {mode === 'signup' && (
            <form onSubmit={handleSignup} className="space-y-4">
              <div className="border-b border-[#2D3139] pb-3">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <User className="w-4 h-4 text-purple-400" />
                  Teacher Profile Registration & Multi-Device Linking
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Set up your educator profile with your email to enable automatic multi-device synchronization.
                </p>
              </div>

              {/* Teacher Full Name */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Teacher Full Name *
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    required
                    id="signup-name"
                    value={signupName}
                    onChange={e => setSignupName(e.target.value)}
                    placeholder="Teacher Name"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition font-medium"
                  />
                </div>
              </div>

              {/* Date of Birth */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Date of Birth * <span className="text-slate-400 text-[10px] font-normal">(e.g. DD/MM/YYYY or DD-MM-YYYY)</span>
                </label>
                <div className="relative">
                  <Calendar className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    required
                    id="signup-dob"
                    value={signupDob}
                    onChange={e => setSignupDob(e.target.value)}
                    placeholder="DD/MM/YYYY or YYYY-MM-DD"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition font-mono placeholder:text-slate-600"
                  />
                </div>
              </div>

              {/* Unique School Code Notice */}
              <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-200/90 font-medium leading-relaxed">
                  Do not use the original school code here. The school must create its own unique code and use that to log in to this portal.
                </p>
              </div>

              {/* Email & Phone */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Email Address * <span className="text-purple-400 font-bold">(Key for Multi-Device)</span>
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type="email"
                      required
                      id="signup-email"
                      value={signupEmail}
                      onChange={e => setSignupEmail(e.target.value)}
                      placeholder="teacher@gmail.com"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Phone Number
                  </label>
                  <div className="relative">
                    <Phone className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type="tel"
                      id="signup-phone"
                      value={signupPhone}
                      onChange={e => setSignupPhone(e.target.value)}
                      placeholder="+91 98470 54321"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* School Name & School Code */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    School / College Name *
                  </label>
                  <div className="relative">
                    <School className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type="text"
                      required
                      id="signup-school"
                      value={signupSchool}
                      onChange={e => setSignupSchool(e.target.value)}
                      placeholder="Enter your school name"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    School Code *
                  </label>
                  <div className="relative">
                    <Hash className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type="text"
                      required
                      id="signup-schoolcode"
                      value={signupSchoolCode}
                      onChange={e => setSignupSchoolCode(e.target.value)}
                      placeholder="Enter your school code"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition font-mono uppercase"
                    />
                  </div>
                </div>
              </div>

              {/* Academic Year */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Academic Year *
                </label>
                <div className="relative">
                  <Calendar className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    required
                    id="signup-academicyear"
                    value={signupAcademicYear}
                    onChange={e => setSignupAcademicYear(e.target.value)}
                    placeholder="Enter academic year (e.g. 2026-27 or 2025-26)"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition font-mono"
                  />
                </div>
              </div>

              {/* Subject Assigned & Designation */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Subject Assigned *
                  </label>
                  <div className="relative">
                    <BookOpen className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type="text"
                      required
                      id="signup-subject"
                      value={signupSubject}
                      onChange={e => setSignupSubject(e.target.value)}
                      placeholder="e.g. Physics, Chemistry, Mathematics..."
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500 transition font-medium"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Designation / Title
                  </label>
                  <div className="relative">
                    <Award className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type="text"
                      id="signup-designation"
                      value={signupDesignation}
                      onChange={e => setSignupDesignation(e.target.value)}
                      placeholder="e.g. HSST & Class Teacher"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition"
                    />
                  </div>
                </div>
              </div>

                            {/* Assigned Class Standard, Stream & Section */}
              <div className="p-3.5 rounded-2xl bg-[#0F1115] border border-[#2D3139] space-y-3">
                <span className="text-[11px] font-bold text-purple-300 uppercase tracking-wider block">
                  Assigned Class Details
                </span>
                
                <div className="flex items-center gap-2 mb-2">
                  <input 
                    type="checkbox" 
                    id="signup-isClassTeacher"
                    checked={signupIsClassTeacher}
                    onChange={e => setSignupIsClassTeacher(e.target.checked)}
                    className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 bg-[#1A1C23] border-[#2D3139]"
                  />
                  <label htmlFor="signup-isClassTeacher" className="text-[11px] font-bold text-slate-300 cursor-pointer">
                    I am a Class Teacher
                  </label>
                </div>

                {signupIsClassTeacher && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">Standard</label>
                    <select
                      value={signupStandard}
                      onChange={e => setSignupStandard(e.target.value)}
                      className="w-full px-2.5 py-2 rounded-xl bg-[#1A1C23] border border-[#2D3139] text-xs font-semibold text-white focus:outline-none focus:border-purple-500"
                    >
                      <option value="Class 12 (Plus Two)">Class 12 (Plus Two)</option>
                      <option value="Class 11 (Plus One)">Class 11 (Plus One)</option>
                      <option value="Class 10">Class 10</option>
                      <option value="Class 9">Class 9</option>
                      <option value="Other">Other - Enter Manually</option>
                    </select>
                    {signupStandard === 'Other' && (
                      <input
                        type="text"
                        value={customStandard}
                        onChange={e => setCustomStandard(e.target.value)}
                        placeholder="e.g. Class 8"
                        className="w-full mt-2 px-2.5 py-1.5 rounded-xl bg-[#1A1C23] border border-[#2D3139] text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500"
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">Stream</label>
                    <select
                      value={signupStream}
                      onChange={e => setSignupStream(e.target.value)}
                      className="w-full px-2.5 py-2 rounded-xl bg-[#1A1C23] border border-[#2D3139] text-xs font-semibold text-white focus:outline-none focus:border-purple-500"
                    >
                      <option value="Bio-Science">Bio-Science</option>
                      <option value="Computer-Science">Computer-Science</option>
                      <option value="Commerce">Commerce</option>
                      <option value="Humanities">Humanities</option>
                      <option value="General">General</option>
                      <option value="Other">Other - Enter Manually</option>
                    </select>
                    {signupStream === 'Other' && (
                      <input
                        type="text"
                        value={customStream}
                        onChange={e => setCustomStream(e.target.value)}
                        placeholder="e.g. Vocational"
                        className="w-full mt-2 px-2.5 py-1.5 rounded-xl bg-[#1A1C23] border border-[#2D3139] text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500"
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">Section</label>
                    <input
                      type="text"
                      value={signupSection}
                      onChange={e => setSignupSection(e.target.value.toUpperCase())}
                      placeholder="A"
                      className="w-full px-2.5 py-2 rounded-xl bg-[#1A1C23] border border-[#2D3139] text-xs font-bold text-white text-center focus:outline-none focus:border-purple-500"
                    />
                  </div>
                </div>
                )}
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Create Password / Access PIN *
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type={showSignupPassword ? 'text' : 'password'}
                    required
                    id="signup-password"
                    value={signupPassword}
                    onChange={e => setSignupPassword(e.target.value)}
                    placeholder="Create a 6+ character password"
                    className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition"
                  />
                  <button
                    type="button"
                    id="btn-toggle-signup-password"
                    onClick={() => setShowSignupPassword(prev => !prev)}
                    title={showSignupPassword ? 'Hide password' : 'Show password'}
                    aria-label={showSignupPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3.5 top-2.5 p-1 rounded-lg text-slate-400 hover:text-white hover:bg-[#252830] transition cursor-pointer"
                  >
                    {showSignupPassword ? <EyeOff className="w-4 h-4 text-purple-400" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isLoading}
                id="btn-teacher-signup-submit"
                className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-extrabold text-sm shadow-xl shadow-purple-950/60 transition active:scale-95 flex items-center justify-center gap-2 mt-2 cursor-pointer disabled:opacity-50"
              >
                <span>CREATE TEACHER ACCOUNT & ENABLE SYNC</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

          )}
          {/* 2. TEACHER LOGIN FORM */}
          {mode === 'login' && (
            <form onSubmit={handleTeacherLogin} className="space-y-4">
              <div className="border-b border-[#2D3139] pb-3 flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Lock className="w-4 h-4 text-purple-400" />
                    Teacher Portal Sign In
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Log in with your registered email to synchronize your records across all devices.
                  </p>
                </div>
                <div className="hidden sm:flex items-center gap-1 text-[11px] text-purple-400 font-semibold bg-purple-500/10 px-2 py-1 rounded-lg border border-purple-500/20">
                  <Globe className="w-3.5 h-3.5" />
                  <span>Cloud Ready</span>
                </div>
              </div>

              {/* Email or Phone */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Registered Email Address or Phone *
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    required
                    id="login-email"
                    value={loginEmailOrPhone}
                    onChange={e => setLoginEmailOrPhone(e.target.value)}
                    placeholder="teacher.hss@gmail.com or +91..."
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition"
                  />
                </div>
                <span className="text-[10px] text-slate-400 mt-1 block">
                  Use the same email on multiple devices to keep all student and attendance data in sync.
                </span>
              </div>

              {/* School Code */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Hash className="w-3.5 h-3.5 text-purple-400" />
                    School Code 
                  </label>
                  <span className="text-[10px] text-purple-400 font-mono"></span>
                </div>
                <div className="relative">
                  <School className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    id="login-schoolcode"
                    value={loginSchoolCode}
                    onChange={e => setLoginSchoolCode(e.target.value)}
                    placeholder="Enter your school code"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition font-mono uppercase"
                  />
                </div>
              </div>

              {/* Academic Year */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-purple-400" />
                    Academic Year
                  </label>
                  {loginAcademicYear && (
                    <span className="text-[10px] text-emerald-400 font-semibold flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Auto-loaded
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Calendar className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    id="login-academicyear"
                    value={loginAcademicYear}
                    onChange={e => setLoginAcademicYear(e.target.value)}
                    placeholder="Enter academic year (e.g. 2026-27 or 2025-26)"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition font-mono"
                  />
                </div>
              </div>

              {/* School Code Notice */}
              <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-200/90 font-medium leading-relaxed">
                  Do not use the original school code here. The school must create its own unique code and use that to log in to this portal.
                </p>
              </div>

              {/* Date of Birth */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Date of Birth <span className="text-slate-400 text-[10px] font-normal">(e.g. DD/MM/YYYY or DD-MM-YYYY)</span>
                </label>
                <div className="relative">
                  <Calendar className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    id="login-dob"
                    value={loginDob}
                    onChange={e => setLoginDob(e.target.value)}
                    placeholder="DD/MM/YYYY or YYYY-MM-DD"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition font-mono placeholder:text-slate-600"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Password / PIN *
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type={showLoginPassword ? 'text' : 'password'}
                    required
                    id="login-password"
                    value={loginPassword}
                    onChange={e => setLoginPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition"
                  />
                  <button
                    type="button"
                    id="btn-toggle-login-password"
                    onClick={() => setShowLoginPassword(prev => !prev)}
                    title={showLoginPassword ? 'Hide password' : 'Show password'}
                    aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3.5 top-2.5 p-1 rounded-lg text-slate-400 hover:text-white hover:bg-[#252830] transition cursor-pointer"
                  >
                    {showLoginPassword ? <EyeOff className="w-4 h-4 text-purple-400" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="flex justify-end mt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setResetRole('teacher');
                      if (loginEmailOrPhone && loginEmailOrPhone.includes('@')) {
                        setResetEmail(loginEmailOrPhone.trim());
                      }
                      setMode('reset');
                      setErrorMsg(null);
                      setSuccessMsg(null);
                    }}
                    className="text-xs font-bold text-purple-400 hover:text-purple-300 transition underline cursor-pointer flex items-center gap-1.5"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>Forgot Password? Reset via Email</span>
                  </button>
                </div>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isLoading}
                id="btn-teacher-login-submit"
                className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-extrabold text-sm shadow-xl shadow-purple-950/60 transition active:scale-95 flex items-center justify-center gap-2 mt-2 cursor-pointer disabled:opacity-50"
              >
                <span>SIGN IN & SYNC MULTI-DEVICE DATA</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

          )}
          {/* 3. SCHOOL ADMIN LOGIN FORM */}
          {mode === 'admin' && (
            <div className="space-y-4">
              <form onSubmit={handleAdminLogin} className="space-y-4">
                <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
                  <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400 shrink-0">
                    <ShieldCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-amber-300">
                      School Administrator Portal Authentication
                    </h3>
                    <p className="text-xs text-amber-200/80 mt-0.5">
                      Enter the authorized School Gmail, unique School Code, and Password provisioned in Firebase.
                    </p>
                  </div>
                </div>

                {/* 1. School Gmail Address */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    School Gmail Address *
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type="email"
                      required
                      id="admin-gmail"
                      value={adminGmail}
                      onChange={e => setAdminGmail(e.target.value)}
                      placeholder="e.g. principal.ghss@gmail.com"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-amber-500 transition font-medium"
                    />
                  </div>
                </div>

                {/* 2. School Code */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                      <Hash className="w-3.5 h-3.5 text-amber-400" />
                      School Code *
                    </label>
                    <span className="text-[10px] text-amber-400 font-mono">Unique Institutional ID</span>
                  </div>
                  <div className="relative">
                    <School className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type="text"
                      required
                      id="admin-schoolcode"
                      value={adminSchoolCode}
                      onChange={e => setAdminSchoolCode(e.target.value)}
                      placeholder="Enter your school code"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-amber-500 transition font-mono uppercase"
                    />
                  </div>
                </div>

                {/* Head of School Designation */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Award className="w-3.5 h-3.5 text-amber-400" />
                    Head of School Designation *
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setAdminDesignation('Principal')}
                      className={`py-2 px-2.5 rounded-xl text-xs font-extrabold border transition-all cursor-pointer text-center ${
                        adminDesignation === 'Principal'
                          ? 'bg-amber-600/20 border-amber-500 text-amber-300 shadow-md'
                          : 'bg-[#0F1115] border-[#2D3139] text-slate-400 hover:text-white'
                      }`}
                    >
                      Principal
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdminDesignation('Headmaster')}
                      className={`py-2 px-2.5 rounded-xl text-xs font-extrabold border transition-all cursor-pointer text-center ${
                        adminDesignation === 'Headmaster'
                          ? 'bg-amber-600/20 border-amber-500 text-amber-300 shadow-md'
                          : 'bg-[#0F1115] border-[#2D3139] text-slate-400 hover:text-white'
                      }`}
                    >
                      Headmaster
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdminDesignation('Headmistress')}
                      className={`py-2 px-2.5 rounded-xl text-xs font-extrabold border transition-all cursor-pointer text-center ${
                        adminDesignation === 'Headmistress'
                          ? 'bg-amber-600/20 border-amber-500 text-amber-300 shadow-md'
                          : 'bg-[#0F1115] border-[#2D3139] text-slate-400 hover:text-white'
                      }`}
                    >
                      Headmistress
                    </button>
                  </div>
                </div>

                {/* 3. Password */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                      Password *
                    </label>
                    <span className="text-[10px] text-slate-400">Firebase Auth Managed</span>
                  </div>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                    <input
                      type={showAdminPassword ? 'text' : 'password'}
                      required
                      id="admin-password"
                      value={adminPassword}
                      onChange={e => setAdminPassword(e.target.value)}
                      placeholder="Enter School Admin Password"
                      className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-amber-500 transition"
                    />
                    <button
                      type="button"
                      id="btn-toggle-admin-password"
                      onClick={() => setShowAdminPassword(prev => !prev)}
                      title={showAdminPassword ? 'Hide password' : 'Show password'}
                      aria-label={showAdminPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3.5 top-2.5 p-1 rounded-lg text-slate-400 hover:text-white hover:bg-[#252830] transition cursor-pointer"
                    >
                      {showAdminPassword ? <EyeOff className="w-4 h-4 text-amber-400" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <div className="flex justify-end mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setResetRole('admin');
                        if (adminGmail && adminGmail.includes('@')) {
                          setResetEmail(adminGmail.trim());
                        }
                        setMode('reset');
                        setErrorMsg(null);
                        setSuccessMsg(null);
                      }}
                      className="text-xs font-bold text-amber-400 hover:text-amber-300 transition underline cursor-pointer flex items-center gap-1.5"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>Forgot Password? Reset via Email</span>
                    </button>
                  </div>
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={isLoading}
                  id="btn-admin-login-submit"
                  className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-amber-600 via-amber-500 to-rose-600 hover:from-amber-500 hover:to-rose-500 text-white font-extrabold text-sm shadow-xl shadow-amber-950/60 transition active:scale-95 flex items-center justify-center gap-2 mt-2 cursor-pointer disabled:opacity-50"
                >
                  <ShieldCheck className="w-4.5 h-4.5" />
                  <span>LOG IN TO SCHOOL ADMIN PORTAL</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            </div>

          )}
          {/* 4. PASSWORD RESET & SETTINGS RECOVERY FORM */}
          {mode === 'reset' && (
            <form onSubmit={handlePasswordReset} className="space-y-4 animate-fade-in">
              <div className="border-b border-[#2D3139] pb-3">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <KeyRound className="w-5 h-5 text-purple-400" />
                  Forgot Password? Secure Account Recovery
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Recover your account safely using Firebase Authentication. Enter your registered email address to receive an official password reset link.
                </p>
              </div>

              {/* Role selector inside reset screen */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Select Account Role *
                </label>
                <div className="grid grid-cols-2 gap-2 bg-[#1A1C23] p-1 rounded-xl border border-[#2D3139]">
                  <button
                    type="button"
                    onClick={() => {
                      setResetRole('teacher');
                      setErrorMsg(null);
                      setSuccessMsg(null);
                    }}
                    className={`py-2 px-3 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                      resetRole === 'teacher'
                        ? 'bg-purple-600 text-white shadow-md shadow-purple-900/40'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Teacher Account
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResetRole('admin');
                      setErrorMsg(null);
                      setSuccessMsg(null);
                    }}
                    className={`py-2 px-3 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                      resetRole === 'admin'
                        ? 'bg-amber-600 text-white shadow-md shadow-amber-900/40'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    School Administrator
                  </button>
                </div>
              </div>

              {/* Registered Email */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Registered {resetRole === 'teacher' ? 'Teacher' : 'Administrator'} Email *
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="email"
                    required
                    value={resetEmail}
                    onChange={e => setResetEmail(e.target.value)}
                    placeholder={resetRole === 'teacher' ? 'teacher.hss@gmail.com' : 'principal.ghss@gmail.com'}
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#0F1115] border border-[#2D3139] text-sm text-white focus:outline-none focus:border-purple-500 transition font-medium"
                  />
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  Firebase Authentication will email a secure, single-use password reset link.
                </p>
              </div>

              {/* Security & Database Protection Notice */}
              <div className="p-3 rounded-xl bg-[#14161C] border border-emerald-500/20 text-xs text-slate-300 flex items-start gap-2.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  <span className="font-semibold text-emerald-400">Secure Firebase Recovery: </span>
                  Passwords are authenticated and encrypted using Firebase Authentication's industry-standard cryptographic hashing. Plaintext passwords are never stored, logged, or compromised in any database.
                </p>
              </div>

              {/* Submit Buttons */}
              <div className="grid grid-cols-2 gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => {
                    setMode(resetRole === 'teacher' ? 'login' : 'admin');
                    setErrorMsg(null);
                    setSuccessMsg(null);
                  }}
                  className="w-full py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-sm transition active:scale-95 cursor-pointer text-center"
                >
                  {successMsg ? 'BACK TO LOGIN' : 'CANCEL & RETURN'}
                </button>

                <button
                  type="submit"
                  disabled={isLoading}
                  className={`w-full py-3 rounded-2xl text-white font-extrabold text-sm shadow-xl transition active:scale-95 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 ${
                    resetRole === 'teacher'
                      ? 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-purple-950/60'
                      : 'bg-gradient-to-r from-amber-600 to-rose-600 hover:from-amber-500 hover:to-rose-500 shadow-amber-950/60'
                  }`}
                >
                  <span>{successMsg ? 'RESEND RESET LINK' : 'SEND RESET LINK'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Security & Features Summary Badges */}
        <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <Cloud className="w-4 h-4 text-purple-400" /> Multi-Device Cloud Real-Time Sync
          </span>
          <span>•</span>
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-400" /> Teacher & Admin Data Protection
          </span>
          <span>•</span>
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-amber-400" /> Instant School Network Linking
          </span>
        </div>
      </div>
    </div>
  );
};
