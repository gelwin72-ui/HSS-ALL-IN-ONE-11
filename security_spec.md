# Security Specification — HSS ALL IN ONE (`hss-all-in-one-1`)

## 1. Data Invariants
1. **Default-Deny Catch-All**: Every path not explicitly matched under `/databases/{database}/documents` is rejected (`allow read, write: if false;`).
2. **Authentication Required**: No user data, school roster, attendance, exam, timetable, or cloud file document may be read or written by an unauthenticated client (`request.auth != null`). Only `/test/connection` permits an unauthenticated `get` ping for initial SDK connectivity checks.
3. **Zero Plaintext Passwords**: No Firestore document (`users`, `teachers`, `teacherSignups`, `teacher_credentials`, `admin_credentials`, `gmail`, `schools/{schoolCode}/gmail`, `schools/{schoolCode}/teachers`, `email_accounts`) may contain a `password` or `adminPassword` field on write.
4. **UID-Bound Identity Integrity**: User profiles (`/users/{userId}`), teacher profiles (`/teachers/{teacherId}`, `/teacherSignups/{teacherId}`), notification preferences (`/notification_preferences/{userId}`), and FCM tokens (`/fcm_tokens/{userId}/tokens/{tokenId}`) enforce ownership (`request.auth.uid == userId`) or verified School Admin override.
5. **Privilege Escalation Prevention**: Non-admin users cannot set `role` to `'admin'` or `'schoolAdmin'` on `/users/{userId}` create, nor modify `role` on update. `/admins/{userId}`, `/schoolAdmins/{userId}`, and `/schools/{schoolCode}/schoolAdmins/{adminId}` require an existing `/admins/{request.auth.uid}` entry or a verified pre-authorized admin token (`request.auth.token.email_verified == true` and allowlisted email).
6. **Tenant Isolation by `schoolCode`**: Teachers may only access `/schools/{schoolCode}/...` records (including `schools/{schoolCode}/gmail`, `schools/{schoolCode}/teachers`, classes, students, attendance, exams, timetables) if their `/users/{request.auth.uid}` record belongs to that `schoolCode` (or they own the specific sub-document), and broadcasts/audit logs are admin-managed (`isSchoolAdmin(schoolCode)`).
7. **Schema & Size Bounds**: Every string field enforces strict `.size()` upper bounds, document IDs pass `isValidId()` (`^[a-zA-Z0-9_\-\.@]+$` up to 128 chars where schoolCodes contain `@` or `^[a-zA-Z0-9_\-]+$` for generated IDs), and shadow/ghost fields are rejected via `keys().hasAll(...)` / `keys().hasOnly(...)` / `affectedKeys().hasOnly(...)`.
8. **Secure List Queries**: Every `allow list` rule evaluates `resource.data` directly without invoking `get()` or `exists()` to prevent O(n) read amplification attacks.

## 2. The "Dirty Dozen" Attack Payloads (Expected: `PERMISSION_DENIED`)
1. **Unauthenticated Profile Read**: Anonymous client attempts `GET /users/teacher_123` -> `PERMISSION_DENIED`.
2. **Cross-User Profile Hijack**: Teacher A (`uid_A`) attempts `SET /users/uid_B` -> `PERMISSION_DENIED`.
3. **Self-Privilege Escalation on Create**: Teacher A (`uid_A`) creates `/users/uid_A` with `{ role: 'admin', schoolCode: 'SSHSS@111213', email: 'a@gmail.com' }` -> `PERMISSION_DENIED`.
4. **Role Mutation on Update**: Teacher A (`uid_A`) updates `/users/uid_A` changing `{ role: 'schoolAdmin' }` -> `PERMISSION_DENIED`.
5. **Plaintext Password Injection**: Client attempts `SET /teachers/uid_A` including `{ password: 'secret123', ... }` -> `PERMISSION_DENIED`.
6. **Ghost / Shadow Field Update**: Authenticated user attempts `UPDATE /cloud_files/file_1` with `{ isVerified: true }` -> `PERMISSION_DENIED`.
7. **Admin Email Spoofing (Unverified Email)**: User with `email: 'gelwin72@gmail.com'` and `email_verified: false` attempts `SET /admins/spoof_uid` -> `PERMISSION_DENIED`.
8. **Cross-School Tenant Scraping (`list`)**: Teacher in school `CODE_A` queries `LIST /schools/CODE_B/teachers` -> `PERMISSION_DENIED`.
9. **Unauthorized Broadcast Forgery**: Regular teacher (`uid_A`) attempts `CREATE /schools/SSHSS@111213/broadcasts/b1` -> `PERMISSION_DENIED`.
10. **Audit Log Tampering / Deletion**: Regular teacher attempts `DELETE /schools/SSHSS@111213/auditLogs/log_1` -> `PERMISSION_DENIED`.
11. **Oversized Document ID Poisoning**: Authenticated user attempts `CREATE /cloud_files/{1500-char-id}` -> `PERMISSION_DENIED`.
12. **Blanket User List Scraping**: Non-admin user attempts `LIST /users` without owning/matching filter -> `PERMISSION_DENIED`.
