export type PosCategory = {
  id: string;
  nameAr: string;
  icon: string;
  color: string;
};

export type PosProduct = {
  id: string;
  sku: string;
  nameAr: string;
  price: number;
  vatRate: number;
  categoryId: string;
  emoji: string;
  unit?: string;
  stock?: number;
};

export const categories: PosCategory[] = [
  { id: "all", nameAr: "الكل", icon: "✨", color: "169 100% 38%" },
  { id: "drinks", nameAr: "مشروبات", icon: "☕", color: "25 90% 55%" },
  { id: "food", nameAr: "أطعمة", icon: "🍽️", color: "12 80% 55%" },
  { id: "bakery", nameAr: "مخبوزات", icon: "🥐", color: "40 90% 55%" },
  { id: "dessert", nameAr: "حلويات", icon: "🍰", color: "330 80% 60%" },
  { id: "snacks", nameAr: "وجبات خفيفة", icon: "🍿", color: "50 95% 50%" },
  { id: "groceries", nameAr: "بقالة", icon: "🛒", color: "140 70% 45%" },
];

export const products: PosProduct[] = [
  { id: "p1", sku: "DRK-001", nameAr: "قهوة سعودية", price: 12, vatRate: 15, categoryId: "drinks", emoji: "☕", unit: "كوب", stock: 142 },
  { id: "p2", sku: "DRK-002", nameAr: "قهوة مختصة", price: 18, vatRate: 15, categoryId: "drinks", emoji: "☕", unit: "كوب", stock: 64 },
  { id: "p3", sku: "DRK-003", nameAr: "كابتشينو", price: 16, vatRate: 15, categoryId: "drinks", emoji: "☕", unit: "كوب", stock: 80 },
  { id: "p4", sku: "DRK-004", nameAr: "شاي بالنعناع", price: 8, vatRate: 15, categoryId: "drinks", emoji: "🍵", unit: "كوب", stock: 220 },
  { id: "p5", sku: "DRK-005", nameAr: "عصير برتقال طازج", price: 14, vatRate: 15, categoryId: "drinks", emoji: "🍊", unit: "كوب", stock: 35 },
  { id: "p6", sku: "DRK-006", nameAr: "ماء معدني 500مل", price: 3, vatRate: 15, categoryId: "drinks", emoji: "💧", unit: "قارورة", stock: 480 },

  { id: "p7", sku: "FD-001", nameAr: "كبسة دجاج", price: 35, vatRate: 15, categoryId: "food", emoji: "🍛", unit: "وجبة", stock: 24 },
  { id: "p8", sku: "FD-002", nameAr: "مندي لحم", price: 55, vatRate: 15, categoryId: "food", emoji: "🍖", unit: "وجبة", stock: 18 },
  { id: "p9", sku: "FD-003", nameAr: "شاورما عربي", price: 18, vatRate: 15, categoryId: "food", emoji: "🌯", unit: "قطعة", stock: 60 },
  { id: "p10", sku: "FD-004", nameAr: "برجر لحم", price: 28, vatRate: 15, categoryId: "food", emoji: "🍔", unit: "قطعة", stock: 42 },
  { id: "p11", sku: "FD-005", nameAr: "بيتزا مارجريتا", price: 42, vatRate: 15, categoryId: "food", emoji: "🍕", unit: "قطعة", stock: 16 },
  { id: "p12", sku: "FD-006", nameAr: "سلطة قيصر", price: 22, vatRate: 15, categoryId: "food", emoji: "🥗", unit: "صحن", stock: 30 },

  { id: "p13", sku: "BK-001", nameAr: "كرواسون زبدة", price: 9, vatRate: 15, categoryId: "bakery", emoji: "🥐", unit: "قطعة", stock: 75 },
  { id: "p14", sku: "BK-002", nameAr: "خبز فرنسي", price: 6, vatRate: 15, categoryId: "bakery", emoji: "🥖", unit: "قطعة", stock: 90 },
  { id: "p15", sku: "BK-003", nameAr: "معجنات بالجبن", price: 7, vatRate: 15, categoryId: "bakery", emoji: "🥧", unit: "قطعة", stock: 55 },
  { id: "p16", sku: "BK-004", nameAr: "سندويتش حلوم", price: 16, vatRate: 15, categoryId: "bakery", emoji: "🥪", unit: "قطعة", stock: 28 },

  { id: "p17", sku: "DS-001", nameAr: "كنافة بالقشطة", price: 22, vatRate: 15, categoryId: "dessert", emoji: "🍮", unit: "قطعة", stock: 32 },
  { id: "p18", sku: "DS-002", nameAr: "بسبوسة", price: 10, vatRate: 15, categoryId: "dessert", emoji: "🍰", unit: "قطعة", stock: 48 },
  { id: "p19", sku: "DS-003", nameAr: "تشيز كيك", price: 18, vatRate: 15, categoryId: "dessert", emoji: "🍰", unit: "قطعة", stock: 26 },
  { id: "p20", sku: "DS-004", nameAr: "آيس كريم فانيلا", price: 12, vatRate: 15, categoryId: "dessert", emoji: "🍦", unit: "كرة", stock: 90 },

  { id: "p21", sku: "SN-001", nameAr: "بطاطس مقلية", price: 11, vatRate: 15, categoryId: "snacks", emoji: "🍟", unit: "علبة", stock: 70 },
  { id: "p22", sku: "SN-002", nameAr: "ناتشوز بالجبن", price: 17, vatRate: 15, categoryId: "snacks", emoji: "🥨", unit: "علبة", stock: 45 },
  { id: "p23", sku: "SN-003", nameAr: "تمر مدينة 250غ", price: 25, vatRate: 15, categoryId: "snacks", emoji: "🌴", unit: "علبة", stock: 120 },
  { id: "p24", sku: "SN-004", nameAr: "مكسرات مشكلة", price: 30, vatRate: 15, categoryId: "snacks", emoji: "🥜", unit: "علبة", stock: 56 },

  { id: "p25", sku: "GR-001", nameAr: "حليب طازج 1 لتر", price: 9, vatRate: 15, categoryId: "groceries", emoji: "🥛", unit: "علبة", stock: 200 },
  { id: "p26", sku: "GR-002", nameAr: "بيض كبير 30 حبة", price: 22, vatRate: 15, categoryId: "groceries", emoji: "🥚", unit: "كرتون", stock: 60 },
  { id: "p27", sku: "GR-003", nameAr: "أرز بسمتي 5كجم", price: 65, vatRate: 15, categoryId: "groceries", emoji: "🍚", unit: "كيس", stock: 80 },
  { id: "p28", sku: "GR-004", nameAr: "زيت زيتون 1 لتر", price: 48, vatRate: 15, categoryId: "groceries", emoji: "🫒", unit: "زجاجة", stock: 45 },
];
