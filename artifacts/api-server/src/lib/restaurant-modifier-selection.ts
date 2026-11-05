export type RestaurantModifierGroupLike = {
  id: string;
  nameAr?: string;
  minSelect: number;
  maxSelect: number;
  options: Array<{ id: string; [key: string]: unknown }>;
};

export function validateRestaurantModifierSelection(
  groups: RestaurantModifierGroupLike[],
  rawSelections: unknown,
): Array<{ group: RestaurantModifierGroupLike; option: RestaurantModifierGroupLike["options"][number] }> {
  const selections = Array.isArray(rawSelections) ? rawSelections : [];
  if (selections.length > groups.length) throw new Error("توجد اختيارات غير معروفة");

  const byGroup = new Map<string, Set<string>>();
  for (const raw of selections) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("بيانات الاختيارات غير صالحة");
    const groupId = String((raw as any).groupId ?? "");
    const optionIds = (raw as any).optionIds;
    if (!groupId || byGroup.has(groupId) || !Array.isArray(optionIds)) throw new Error("بيانات الاختيارات غير صالحة");
    const ids = optionIds.map((id: unknown) => String(id));
    if (ids.some((id: string) => !id) || new Set(ids).size !== ids.length) {
      throw new Error("الخيار مكرر أو غير صالح");
    }
    byGroup.set(groupId, new Set(ids));
  }

  for (const groupId of byGroup.keys()) {
    if (!groups.some(group => String(group.id) === groupId)) throw new Error("توجد مجموعة اختيارات غير معروفة");
  }
  const chosen: Array<{ group: RestaurantModifierGroupLike; option: RestaurantModifierGroupLike["options"][number] }> = [];
  for (const group of groups) {
    const selectedIds = byGroup.get(String(group.id)) ?? new Set<string>();
    if (selectedIds.size < Number(group.minSelect) || selectedIds.size > Number(group.maxSelect)) {
      throw new Error(`تحقق من عدد الاختيارات في مجموعة "${group.nameAr ?? ""}"`);
    }
    for (const optionId of selectedIds) {
      const option = (group.options ?? []).find(entry => String(entry.id) === optionId);
      if (!option) throw new Error("يوجد خيار غير مرتبط بهذه المجموعة");
      chosen.push({ group, option });
    }
  }
  return chosen;
}
