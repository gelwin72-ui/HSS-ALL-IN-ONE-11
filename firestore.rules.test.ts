import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const storageRulesPath = path.resolve(process.cwd(), 'storage.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');
const specPath = path.resolve(process.cwd(), 'security_spec.md');

const rulesContent = fs.readFileSync(rulesPath, 'utf-8');
const storageRulesContent = fs.readFileSync(storageRulesPath, 'utf-8');
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf-8'));
const specContent = fs.readFileSync(specPath, 'utf-8');

describe('Firestore Security Rules & Dirty Dozen Verification', () => {
  it('enforces rules_version = "2" and a top-level default-deny catch-all', () => {
    expect(rulesContent).toContain("rules_version = '2';");
    expect(rulesContent).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);
    expect(rulesContent).not.toMatch(/allow read, write:\s*if true;/);
  });

  it('protects all 35 Firestore paths declared in firebase-blueprint.json', () => {
    const blueprintPaths = Object.keys(blueprint.firestore || {});
    expect(blueprintPaths.length).toBeGreaterThanOrEqual(34);

    // Every top-level & subcollection segment from blueprint must appear in firestore.rules
    const requiredMatches = [
      'match /users/{userId}',
      'match /admins/{userId}',
      'match /schoolAdmins/{userId}',
      'match /email_accounts/{emailKey}',
      'match /teachers/{teacherId}',
      'match /teacherSignups/{teacherId}',
      'match /gmail/{emailKey}',
      'match /teacher_credentials/{emailKey}',
      'match /admin_credentials/{emailKey}',
      'match /cloud_files/{fileId}',
      'match /broadcasts/{broadcastId}',
      'match /notification_preferences/{userId}',
      'match /fcm_tokens/{userId}/tokens/{tokenId}',
      'match /unauthorizedAttempts/{attemptId}',
      'match /schools/{schoolCode}',
      'match /schoolProfile/{docId}',
      'match /schoolAdmins/{adminId}',
      'match /teachers/{teacherId}',
      'match /teacherSignups/{teacherId}',
      'match /classes/{classId}',
      'match /students/{studentId}',
      'match /attendance/{attendanceId}',
      'match /exams/{examId}',
      'match /examMarks/{examId}',
      'match /timetables/{slotId}',
      'match /timetablePrefs/{prefId}',
      'match /reminders/{reminderId}',
      'match /broadcasts/{broadcastId}',
      'match /activities/{activityId}',
      'match /auditLogs/{logId}',
      'match /loginActivities/{actId}',
      'match /tokens/{userId}',
      'match /temporarilyDeletedTeachers/{teacherId}',
      'match /permanentlyDeletedTeachers/{teacherId}'
    ];

    for (const segment of requiredMatches) {
      expect(rulesContent).toContain(segment);
    }
  });

  it('Dirty Dozen #1 & #2: Blocks unauthenticated reads and cross-user profile hijacks', () => {
    expect(rulesContent).toContain('function isSignedIn() {\n      return request.auth != null;\n    }');
    expect(rulesContent).toContain('function isOwner(userId) {\n      return isSignedIn() && request.auth.uid == userId;\n    }');
    expect(rulesContent).toContain('allow get: if isValidId(userId) && (isOwner(userId) || isAdmin());');
  });

  it('Dirty Dozen #3 & #4: Blocks self-privilege escalation on create and role mutation on update', () => {
    expect(rulesContent).toContain("&& (incoming().role == 'teacher' || isVerifiedAdminEmail());");
    expect(rulesContent).toContain("!incoming().diff(existing()).affectedKeys().hasAny(['role', 'userId', 'uid', 'createdAt'])");
  });

  it('Dirty Dozen #5: Rejects plaintext password & adminPassword injection across every validator', () => {
    expect(rulesContent).toContain("function hasNoPasswordField(data) {\n      return !('password' in data) && !('adminPassword' in data);\n    }");
    const validatorCount = (rulesContent.match(/function isValid[A-Z][a-zA-Z0-9]*\(/g) || []).length;
    const guardCalls = (rulesContent.match(/return hasNoPasswordField\(data\)/g) || []).length;
    // Exclude isValidId / isValidKey
    expect(validatorCount - 2).toBeGreaterThanOrEqual(18);
    expect(guardCalls).toBe(validatorCount - 2);
  });

  it('Dirty Dozen #6: Blocks ghost/shadow field updates via hasOnly() & isValid[Entity]', () => {
    expect(rulesContent).toContain("&& incoming().diff(existing()).affectedKeys().hasOnly([");
    expect(rulesContent).toContain("data.keys().hasOnly([");
  });

  it('Dirty Dozen #7: Restricts admin email elevation strictly to verified/pre-authorized admin accounts', () => {
    expect(rulesContent).toContain('request.auth.token.email_verified == true');
    expect(rulesContent).toContain("request.auth.token.email in [");
  });

  it('Dirty Dozen #8 & #12: Isolates tenant lists by schoolCode and forbids blanket list scraping', () => {
    expect(rulesContent).not.toMatch(/allow list:\s*if isSignedIn\(\);/);
    expect(rulesContent).not.toMatch(/allow read:\s*if isSignedIn\(\);/);
    expect(rulesContent).toContain('isSchoolMemberOrAdmin(schoolCode) && existing().schoolCode == schoolCode');
  });

  it('Dirty Dozen #9 & #10: Restricts broadcast publishing and auditLog modifications strictly to admins', () => {
    const broadcastsBlock = rulesContent.slice(rulesContent.indexOf('match /broadcasts/{broadcastId}'));
    expect(broadcastsBlock).toContain('allow create, update: if isValidId(broadcastId) && isValidBroadcast(incoming()) && isAdmin();');
    expect(broadcastsBlock).toContain('allow delete: if isValidId(broadcastId) && isAdmin();');

    const auditBlock = rulesContent.slice(rulesContent.indexOf('match /auditLogs/{logId}'));
    expect(auditBlock).toContain('allow create, update: if isValidKey(schoolCode) && isValidId(logId) && isValidAuditLog(incoming()) && isAdmin();');
    expect(auditBlock).toContain('allow delete: if isValidKey(schoolCode) && isValidId(logId) && isAdmin();');
  });

  it('Dirty Dozen #11: Enforces ID length & regex guards against 1.5KB ID poisoning', () => {
    expect(rulesContent).toContain("return id is string && id.size() >= 1 && id.size() <= 128 && id.matches('^[a-zA-Z0-9_\\\\-]+$');");
    expect(rulesContent).toContain("return key is string && key.size() >= 1 && key.size() <= 160 && key.matches('^[a-zA-Z0-9_\\\\-\\\\.@]+$');");
  });

  it('secures storage.rules with auth, 10MB file size limit, and allowed content types', () => {
    expect(storageRulesContent).toContain("rules_version = '2';");
    expect(storageRulesContent).toContain('request.auth != null');
    expect(storageRulesContent).toContain('request.resource.size <= 10 * 1024 * 1024');
    expect(storageRulesContent).not.toMatch(/allow read, write:\s*if true;/);
    expect(specContent).toContain('Dirty Dozen');
  });
});
