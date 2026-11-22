const section = value => value && ['ready','empty','partial','unavailable'].includes(value.state) && Array.isArray(value.items);
function validBrief(value) {
  return ['joe','dell'].includes(value?.sponsor) && value.sections && typeof value.sections === 'object' && !Array.isArray(value.sections) && ['today','deals','loops'].every(key => value.sections[key] === undefined || section(value.sections[key]));
}
export function normalizeBrief(payload) {
  if (!validBrief(payload)) return null;
  const sections = {...payload.sections};
  for (const key of ['today','deals','loops']) sections[key] ??= {state:'unavailable',items:[]};
  return {...payload,sections};
}
