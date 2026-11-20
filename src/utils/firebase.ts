import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  sendEmailVerification
} from 'firebase/auth';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  off,
  query as rtdbQuery,
  orderByChild,
  equalTo,
  Database,
  DataSnapshot
} from 'firebase/database';
import {
  getFirestore,
  initializeFirestore,
  setLogLevel,
  doc as fsDoc,
  getDoc as fsGetDoc,
  setDoc as fsSetDoc,
  updateDoc as fsUpdateDoc,
  deleteDoc as fsDeleteDoc,
  collection as fsCollection,
  query as fsQuery,
  where as fsWhere,
  getDocs as fsGetDocs,
  addDoc as fsAddDoc,
  onSnapshot as fsOnSnapshot,
  orderBy as fsOrderBy,
  serverTimestamp as fsServerTimestamp,
  getDocFromServer as fsGetDocFromServer,
  writeBatch as fsWriteBatch,
  Firestore
} from 'firebase/firestore';
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  uploadString,
  getDownloadURL,
  deleteObject,
  FirebaseStorage
} from 'firebase/storage';
import firebaseConfigJson from '../../firebase-applet-config.json';

// Load authoritative configuration from firebase-applet-config.json with env fallback
const env = (typeof import.meta !== 'undefined' && (import.meta as any).env) ? (import.meta as any).env : {};
const resolvedProjectId = firebaseConfigJson?.projectId || env.VITE_FIREBASE_PROJECT_ID || 'hss-all-in-one-1';
const envDbUrl = env.VITE_FIREBASE_DATABASE_URL || '';

export const firebaseConfig = {
  projectId: resolvedProjectId,
  appId: firebaseConfigJson?.appId || env.VITE_FIREBASE_APP_ID || '1:679893158194:web:5f7cf7e5a953c05330af2b',
  apiKey: firebaseConfigJson?.apiKey || env.VITE_FIREBASE_API_KEY || 'AIzaSyDyI4ZU-UgnoqYr_nicbTIAR5-gDY8aBTw',
  authDomain: firebaseConfigJson?.authDomain || env.VITE_FIREBASE_AUTH_DOMAIN || `${resolvedProjectId}.firebaseapp.com`,
  databaseURL: (firebaseConfigJson as any)?.databaseURL || (envDbUrl.includes(resolvedProjectId) ? envDbUrl : `https://${resolvedProjectId}-default-rtdb.firebaseio.com`),
  firestoreDatabaseId: (firebaseConfigJson as any)?.firestoreDatabaseId || env.VITE_FIREBASE_FIRESTORE_DATABASE_ID || '(default)',
  storageBucket: firebaseConfigJson?.storageBucket || env.VITE_FIREBASE_STORAGE_BUCKET || `${resolvedProjectId}.firebasestorage.app`,
  messagingSenderId: firebaseConfigJson?.messagingSenderId || env.VITE_FIREBASE_MESSAGING_SENDER_ID || '679893158194',
  measurementId: firebaseConfigJson?.measurementId || env.VITE_FIREBASE_MEASUREMENT_ID || 'G-20S3SECRGG',
  oAuthClientId: firebaseConfigJson?.oAuthClientId || env.VITE_FIREBASE_OAUTH_CLIENT_ID || '',
  recaptchaSiteKey: firebaseConfigJson?.recaptchaSiteKey || env.VITE_FIREBASE_RECAPTCHA_SITE_KEY || ''
};

// Safe Single Firebase App Initialization
let appInstance: any = null;
try {
  if (!getApps().length) {
    appInstance = initializeApp(firebaseConfig);
  } else {
    appInstance = getApp();
  }
} catch (err) {
  console.warn('[Firebase] App initialization warning:', err);
  if (getApps().length) {
    appInstance = getApp();
  }
}

const app = appInstance;

// Safe Auth Initialization
let authInstance: any = null;
try {
  authInstance = getAuth(app);
} catch (err) {
  console.warn('[Firebase Auth] Initialization warning:', err);
}
export const auth = authInstance;

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

export const loginWithGoogle = async () => {
  try {
    if (!auth) {
      throw new Error('Firebase Authentication is currently not initialized. Please verify your network connection.');
    }
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error('Error signing in with Google:', error);
    throw error;
  }
};

// Safe RTDB Initialization (only if databaseURL is explicitly configured)
let rtdbInstance: any = null;
try {
  if (firebaseConfig.databaseURL) {
    rtdbInstance = getDatabase(app);
  }
} catch (err) {
  console.warn('[Firebase RTDB] Initialization warning:', err);
}
export const database: Database = rtdbInstance;

// Safe Firestore Initialization - Uses configured named DB or default database
const firestoreDbId = firebaseConfig.firestoreDatabaseId || '(default)';
const useNamedDb = Boolean(firestoreDbId && firestoreDbId !== '(default)');
let firestoreInstance: any = null;
try {
  setLogLevel('error');
} catch {
  // ignore log level config errors
}

try {
  firestoreInstance = useNamedDb
    ? getFirestore(app, firestoreDbId)
    : getFirestore(app);
} catch {
  try {
    const settings = {
      experimentalAutoDetectLongPolling: true,
      ignoreUndefinedProperties: true
    };
    firestoreInstance = useNamedDb
      ? initializeFirestore(app, settings, firestoreDbId)
      : initializeFirestore(app, settings);
  } catch (e) {
    console.warn('[Firebase Firestore] Initialization warning:', e);
  }
}
export const firestore: Firestore = firestoreInstance;
export const db: Firestore = firestoreInstance;

// Safe Cloud Storage Initialization
let storageInstance: FirebaseStorage | null = null;
try {
  storageInstance = getStorage(app);
} catch (err) {
  console.warn('[Firebase Storage] Initialization warning:', err);
}
export const storage: FirebaseStorage | null = storageInstance;

// Direct Firestore Native Exports
export {
  fsDoc,
  fsGetDoc,
  fsSetDoc,
  fsUpdateDoc,
  fsDeleteDoc,
  fsCollection,
  fsQuery,
  fsWhere,
  fsGetDocs,
  fsAddDoc,
  fsOnSnapshot,
  fsOrderBy,
  fsServerTimestamp,
  fsGetDocFromServer,
  fsWriteBatch,
  rtdbQuery
};

export async function testFirestoreConnection(): Promise<{ connected: boolean; error?: string }> {
  if (!firestore) return { connected: false, error: 'Firestore not initialized' };
  try {
    await fsGetDocFromServer(fsDoc(firestore, 'test', 'connection'));
    return { connected: true };
  } catch (error: any) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration. Firestore client is offline.');
      return { connected: false, error: error.message };
    }
    return { connected: true };
  }
}

export async function testConnection(): Promise<void> {
  await testFirestoreConnection();
}

// Run startup connectivity probe in browser
if (typeof window !== 'undefined' && firestore) {
  testConnection().catch(() => {});
}

// Dual-Mode Firestore wrappers (for legacy callers importing { doc, getDoc, ... } from firebase.ts)
export function doc(dbRefOrTarget: any, ...pathSegments: string[]) {
  if (dbRefOrTarget === firestore || dbRefOrTarget === db || (!dbRefOrTarget && firestore)) {
    const fullPath = pathSegments.filter(Boolean).join('/');
    return fsDoc(firestore, fullPath);
  }
  if (typeof dbRefOrTarget === 'string') {
    const fullPath = [dbRefOrTarget, ...pathSegments].filter(Boolean).join('/');
    if (firestore) return fsDoc(firestore, fullPath);
    if (database) return ref(database, fullPath);
  }
  const fullPath = pathSegments.filter(Boolean).join('/');
  if (firestore) return fsDoc(firestore, fullPath);
  if (database) return ref(database, fullPath);
  return null;
}

export async function getDoc(targetRef: any) {
  if (!targetRef) {
    return { exists: () => false, data: () => null };
  }
  if (targetRef && typeof targetRef.path === 'string' && firestore) {
    const snap = await fsGetDoc(targetRef);
    return {
      exists: () => snap.exists(),
      data: () => snap.data()
    };
  }
  if (database) {
    const snapshot: DataSnapshot = await get(targetRef);
    return {
      exists: () => snapshot.exists(),
      data: () => snapshot.val()
    };
  }
  return { exists: () => false, data: () => null };
}

export async function setDoc(targetRef: any, data: any, options?: { merge?: boolean }) {
  if (!targetRef) return;
  if (targetRef && typeof targetRef.path === 'string' && firestore) {
    return await fsSetDoc(targetRef, data, options || {});
  }
  if (database) {
    if (options?.merge) {
      return await update(targetRef, data);
    }
    return await set(targetRef, data);
  }
}

export async function updateDoc(targetRef: any, data: any) {
  if (!targetRef) return;
  if (targetRef && typeof targetRef.path === 'string' && firestore) {
    return await fsUpdateDoc(targetRef, data);
  }
  if (database) {
    return await update(targetRef, data);
  }
}

export async function deleteDoc(targetRef: any) {
  if (!targetRef) return;
  if (targetRef && typeof targetRef.path === 'string' && firestore) {
    return await fsDeleteDoc(targetRef);
  }
  if (database) {
    return await remove(targetRef);
  }
}

export function collection(dbTarget: any, ...pathSegments: string[]) {
  const fullPath = pathSegments.filter(Boolean).join('/');
  if (firestore) {
    return fsCollection(firestore, fullPath);
  }
  return { path: fullPath };
}

export function query(collectionRef: any, ...queryConstraints: any[]) {
  if (firestore && collectionRef) {
    return fsQuery(collectionRef, ...queryConstraints);
  }
  return collectionRef;
}

export function where(fieldPath: string, opStr: any, value: any) {
  return fsWhere(fieldPath, opStr, value);
}

export async function getDocs(queryRef: any) {
  if (firestore && queryRef) {
    return await fsGetDocs(queryRef);
  }
  return { exists: () => false, forEach: () => {}, docs: [], empty: true, size: 0 };
}

export async function addDoc(collectionRef: any, data: any) {
  if (firestore && collectionRef) {
    return await fsAddDoc(collectionRef, data);
  }
  throw new Error('Firestore is not initialized');
}

export function onSnapshot(targetRef: any, onNext: (snap: any) => void, onError?: (err: any) => void) {
  if (firestore && targetRef) {
    return fsOnSnapshot(targetRef, onNext, onError);
  }
  return () => {};
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: Array<{
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }>;
  };
}

export type DatabaseErrorInfo = FirestoreErrorInfo;

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo: (auth?.currentUser?.providerData || []).map((provider: any) => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      }))
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export interface CloudFileUploadParams {
  file: Blob | File | string;
  fileName: string;
  category: 'students' | 'teachers' | 'backups' | 'users' | string;
  schoolCode: string;
  entityId?: string;
  contentType?: string;
  uploadedBy?: string;
  description?: string;
}

export interface CloudFileRecord {
  id: string;
  ownerUid: string;
  fileName: string;
  fileType: string;
  contentType: string;
  category: string;
  entityId: string;
  storagePath: string;
  downloadUrl: string;
  size: number;
  email: string;
  schoolCode: string;
  uploadedBy: string;
  uploadedAt: string;
  createdAt: string;
  updatedAt: string;
  description: string;
}

/**
 * Uploads an image, PDF, CSV, or JSON backup to Firebase Cloud Storage (hss-all-in-one-1.firebasestorage.app)
 * and registers file metadata inside Firestore `cloud_files/{fileId}`.
 */
export async function uploadFileToFirebaseStorage(params: CloudFileUploadParams): Promise<CloudFileRecord> {
  const currentUser = auth?.currentUser;
  if (!currentUser) {
    throw new Error('Authentication required before uploading files to Cloud Storage.');
  }
  if (!storage) {
    throw new Error('Firebase Cloud Storage is not initialized.');
  }

  const cleanSchoolCode = (params.schoolCode || 'SSHSS@111213')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_\-.@]/g, '_');
  const safeFileName = (params.fileName || `file_${Date.now()}`).replace(/[^a-zA-Z0-9._\-]/g, '_');
  const fileId = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const folder = params.category || 'backups';
  const storagePath =
    folder === 'users'
      ? `users/${currentUser.uid}/${fileId}_${safeFileName}`
      : `schools/${cleanSchoolCode}/${folder}/${fileId}_${safeFileName}`;

  const sRef = storageRef(storage, storagePath);
  let detectedContentType = params.contentType || 'application/octet-stream';
  let fileSize = 0;

  if (typeof params.file === 'string') {
    if (params.file.startsWith('data:')) {
      const mimeMatch = params.file.match(/^data:([^;]+);/);
      if (mimeMatch?.[1]) {
        detectedContentType = mimeMatch[1];
      }
      const snapshot = await uploadString(sRef, params.file, 'data_url', {
        contentType: detectedContentType
      });
      fileSize = snapshot.metadata?.size || params.file.length;
    } else {
      const textBlob = new Blob([params.file], { type: detectedContentType });
      const snapshot = await uploadBytes(sRef, textBlob, { contentType: detectedContentType });
      fileSize = snapshot.metadata?.size || textBlob.size;
    }
  } else {
    detectedContentType = params.contentType || params.file.type || detectedContentType;
    const snapshot = await uploadBytes(sRef, params.file, { contentType: detectedContentType });
    fileSize = snapshot.metadata?.size || params.file.size;
  }

  const downloadUrl = await getDownloadURL(sRef);
  const now = new Date().toISOString();

  const record: CloudFileRecord = {
    id: fileId,
    ownerUid: currentUser.uid,
    fileName: safeFileName.slice(0, 255),
    fileType: detectedContentType.slice(0, 100),
    contentType: detectedContentType.slice(0, 100),
    category: String(folder).slice(0, 64),
    entityId: String(params.entityId || currentUser.uid).slice(0, 128),
    storagePath: storagePath.slice(0, 500),
    downloadUrl: downloadUrl.slice(0, 1500),
    size: Number(fileSize) || 0,
    email: (currentUser.email || '').toLowerCase(),
    schoolCode: cleanSchoolCode,
    uploadedBy: (params.uploadedBy || currentUser.displayName || currentUser.email || 'Teacher').slice(0, 150),
    uploadedAt: now,
    createdAt: now,
    updatedAt: now,
    description: (params.description || `${folder} upload`).slice(0, 500)
  };

  if (firestore) {
    try {
      await fsSetDoc(fsDoc(firestore, 'cloud_files', fileId), record);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `cloud_files/${fileId}`);
    }
  }

  return record;
}

export async function deleteCloudStorageFile(storagePath: string, fileId?: string): Promise<void> {
  if (storage && storagePath) {
    try {
      await deleteObject(storageRef(storage, storagePath));
    } catch (err) {
      console.warn('[Firebase Storage] deleteObject warning:', err);
    }
  }
  if (firestore && fileId) {
    try {
      await fsDeleteDoc(fsDoc(firestore, 'cloud_files', fileId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `cloud_files/${fileId}`);
    }
  }
}

export function sanitizeSchoolCode(schoolCode?: string, fallback: string = 'SSHSS@111213'): string {
  const raw = (schoolCode || '').trim().toUpperCase();
  if (!raw) return fallback;
  const cleaned = raw.replace(/\s+/g, '_').replace(/[^A-Z0-9_\-.@]/g, '_').slice(0, 64);
  return cleaned || fallback;
}

/**
 * Saves entered Gmail, DOB, UID, schoolCode, and auth metadata in Firestore
 * (`gmail/${safeKey}`, `teacher_credentials/${safeKey}`, and `schools/${cleanCode}/gmail/${safeKey}`)
 * strictly WITHOUT storing plaintext passwords (all passwords reside securely in Firebase Auth).
 */
export const storeCredentialsInRTDB = async (
  gmail: string,
  _password?: string,
  dob?: string,
  schoolCode?: string,
  name?: string,
  uid?: string,
  authProvider: string = 'email_password'
): Promise<void> => {
  if (!gmail) return;
  const currentUser = auth?.currentUser;
  const resolvedUid = uid || currentUser?.uid;
  if (!resolvedUid) return;

  const cleanEmail = gmail.trim().toLowerCase();
  if (!cleanEmail.includes('@')) return;
  const safeKey = cleanEmail.replace(/[^a-z0-9_]/g, '_');
  const cleanCode = sanitizeSchoolCode(schoolCode);
  const now = new Date().toISOString();
  const payload: Record<string, any> = {
    uid: resolvedUid,
    teacherId: resolvedUid,
    gmail: cleanEmail,
    email: cleanEmail,
    schoolCode: cleanCode,
    role: 'teacher',
    loginMethod: authProvider === 'google' ? 'google' : 'email',
    authProvider,
    passwordProtected: true,
    credentialStatus: 'Firebase Auth Protected',
    lastEntryAt: now,
    updatedAt: now
  };
  if (dob !== undefined && dob !== '') {
    payload.dob = String(dob).slice(0, 32);
    payload.dateOfBirth = String(dob).slice(0, 32);
  }
  if (name) {
    payload.name = name.trim().slice(0, 150);
  }

  if (database) {
    try {
      await Promise.allSettled([
        update(ref(database, `gmail/${safeKey}`), payload),
        update(ref(database, `schools/${cleanCode}/gmail/${safeKey}`), payload)
      ]);
    } catch (e) {
      console.warn('RTDB gmail directory sync note:', e);
    }
  }
  if (firestore) {
    try {
      await fsSetDoc(fsDoc(firestore, 'gmail', safeKey), payload, { merge: true });
      await Promise.allSettled([
        fsSetDoc(fsDoc(firestore, 'teacher_credentials', safeKey), payload, { merge: true }),
        fsSetDoc(fsDoc(firestore, `schools/${cleanCode}/gmail/${safeKey}`), payload, { merge: true })
      ]);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `gmail/${safeKey}`);
    }
  }
};

export {
  app,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  sendEmailVerification,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  off,
  orderByChild,
  equalTo
};
export default app;
export type { FirebaseUser };
