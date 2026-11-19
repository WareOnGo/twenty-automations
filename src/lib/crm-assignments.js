export const WORKSPACE_MEMBER_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const FIELDS = ["primaryAssigneeUserId", "secondaryAssigneeUserId"];

// Assignment identity is always a Workspace Member UUID, never a display name,
// core.user ID, owner, or the retired dropdown fields.
export function assigneeIds(record) {
  const ids = FIELDS.map(field => {
    if (!Object.hasOwn(record, field)) throw new Error("CRM_USER_ASSIGNMENT_FIELDS_MISSING");
    const id = record[field];
    if (id === null) return null;
    if (typeof id !== "string" || !WORKSPACE_MEMBER_ID.test(id)) throw new Error("INVALID_CRM_ASSIGNEES");
    return id.toLowerCase();
  });
  return [...new Set(ids.filter(Boolean))];
}

// This alias was explicitly confirmed during WareOnGo's user-field migration.
const CONFIRMED_ALIASES = { MANOHARI: "4a71485c-0f5c-43a3-bd6e-42f0b98360cf" };

export function resolveAssigneeNames(names, members) {
  const ids = [];
  for (const name of names) {
    const key = name.trim().toUpperCase();
    const matches = members.filter(member => member.deletedAt === null &&
      (CONFIRMED_ALIASES[key] ? member.id === CONFIRMED_ALIASES[key]
        : [member.name?.firstName, `${member.name?.firstName || ""} ${member.name?.lastName || ""}`]
          .some(value => value?.trim().toUpperCase() === key)));
    if (matches.length !== 1 || !WORKSPACE_MEMBER_ID.test(matches[0].id)) {
      throw new Error("CRM_ASSIGNEE_IDENTITY_UNRESOLVED");
    }
    const id = matches[0].id.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > 2) throw new Error("CRM_MAX_TWO_ASSIGNEES");
  return { primaryAssigneeUserId: ids[0] || null, secondaryAssigneeUserId: ids[1] || null };
}
