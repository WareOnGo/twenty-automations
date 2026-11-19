const ids = { MANEESH: 12, NIHAS: 19, RAGHAV: 1, DHAVAL: 2, JAYANTH: 5, OTHER: 6, UNKNOWN: 99 };
export const memberId = id => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
export const memberFor = name => memberId(ids[name]);
export function assignment(names) {
  if (names.length > 2) throw new Error('Test fixture exceeds two assignment slots');
  return { primaryAssigneeUserId: names[0] ? memberFor(names[0]) : null,
    secondaryAssigneeUserId: names[1] ? memberFor(names[1]) : null };
}
