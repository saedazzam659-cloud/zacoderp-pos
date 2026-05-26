// Generate Egyptian grocery catalog CSV (~650 items) with valid 622-prefixed
// EAN-13 barcodes for import into the POS items screen.
import fs from 'node:fs';
import path from 'node:path';

function checkDigit(d12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return ((10 - (sum % 10)) % 10).toString();
}

let prodSeq = 0;
function makeBarcode(companyCode) {
  prodSeq++;
  const cc = String(companyCode).padStart(4, '0');
  const ps = String(prodSeq).padStart(5, '0');
  const d12 = '622' + cc + ps;
  return d12 + checkDigit(d12);
}

const rows = [['code', 'nameAr', 'nameEn', 'barcode', 'salePrice', 'vatRate']];
let codeSeq = 1000;
const VAT = 14;

function add(nameAr, nameEn, salePrice, companyCode) {
  const code = `ITM-${codeSeq++}`;
  const barcode = makeBarcode(companyCode);
  rows.push([code, nameAr, nameEn, barcode, salePrice.toFixed(2), VAT]);
}

function addMany(list, companyCode) {
  for (const [a, e, p] of list) add(a, e, p, companyCode);
}

// ─── 1. DAIRY (~75) ────────────────────────────────────────────────
addMany([
  ['حليب جهينة كامل الدسم 1 لتر','Juhayna Full Cream Milk 1L',38],
  ['حليب جهينة قليل الدسم 1 لتر','Juhayna Low Fat Milk 1L',38],
  ['حليب جهينة خالي الدسم 1 لتر','Juhayna Skimmed Milk 1L',37],
  ['حليب جهينة بالشوكولاتة 200 مل','Juhayna Chocolate Milk 200ml',12],
  ['حليب جهينة بالفراولة 200 مل','Juhayna Strawberry Milk 200ml',12],
  ['حليب جهينة بالموز 200 مل','Juhayna Banana Milk 200ml',12],
  ['حليب جهينة كامل الدسم 250 مل','Juhayna Full Cream Milk 250ml',11],
  ['حليب جهينة كامل الدسم 500 مل','Juhayna Full Cream Milk 500ml',22],
  ['زبادي جهينة 105جم','Juhayna Yogurt 105g',8],
  ['زبادي جهينة 170جم','Juhayna Yogurt 170g',12],
  ['زبادي جهينة بالفواكه 105جم','Juhayna Fruit Yogurt 105g',10],
  ['زبادي جهينة لايت 170جم','Juhayna Light Yogurt 170g',13],
  ['زبادي جهينة دريم 170جم','Juhayna Dream Yogurt 170g',14],
  ['زبادي يوناني جهينة 150جم','Juhayna Greek Yogurt 150g',18],
  ['قشطة جهينة 100جم','Juhayna Cream 100g',16],
  ['قشطة جهينة 200جم','Juhayna Cream 200g',28],
  ['كريم كراميل جهينة','Juhayna Cream Caramel',14],
  ['أرز باللبن جهينة','Juhayna Rice Pudding',15],
  ['مهلبية جهينة','Juhayna Muhalabia',14],
], 101);

addMany([
  ['عصير جهينة بيور برتقال 1 لتر','Juhayna Pure Orange Juice 1L',35],
  ['عصير جهينة بيور مانجو 1 لتر','Juhayna Pure Mango Juice 1L',38],
  ['عصير جهينة بيور جوافة 1 لتر','Juhayna Pure Guava Juice 1L',37],
  ['عصير جهينة بيور فراولة 1 لتر','Juhayna Pure Strawberry Juice 1L',38],
  ['عصير جهينة بيور أناناس 1 لتر','Juhayna Pure Pineapple Juice 1L',37],
  ['عصير جهينة بيور كوكتيل 1 لتر','Juhayna Pure Cocktail Juice 1L',37],
  ['عصير جهينة برتقال 235 مل','Juhayna Orange Juice 235ml',10],
  ['عصير جهينة مانجو 235 مل','Juhayna Mango Juice 235ml',11],
  ['عصير جهينة كوكتيل 235 مل','Juhayna Cocktail Juice 235ml',11],
  ['عصير جهينة فيستا برتقال 200 مل','Juhayna Vista Orange 200ml',6],
  ['عصير جهينة فيستا مانجو 200 مل','Juhayna Vista Mango 200ml',6],
  ['عصير جهينة فيستا تفاح 200 مل','Juhayna Vista Apple 200ml',6],
  ['نكتار جهينة برتقال 1 لتر','Juhayna Nectar Orange 1L',26],
  ['نكتار جهينة مانجو 1 لتر','Juhayna Nectar Mango 1L',28],
], 102);

addMany([
  ['جبنة دومتي بيضاء 500جم','Domty White Cheese 500g',75],
  ['جبنة دومتي بيضاء 1000جم','Domty White Cheese 1Kg',140],
  ['جبنة دومتي فيتا 250جم','Domty Feta 250g',45],
  ['جبنة دومتي فيتا 500جم','Domty Feta 500g',85],
  ['جبنة دومتي قليلة الملح 500جم','Domty Low Salt Cheese 500g',78],
  ['جبنة دومتي شيدر 200جم','Domty Cheddar 200g',45],
  ['جبنة دومتي شيدر شرائح 200جم','Domty Cheddar Slices 200g',48],
  ['جبنة دومتي موزاريلا 200جم','Domty Mozzarella 200g',55],
  ['جبنة دومتي موزاريلا مبشورة 200جم','Domty Shredded Mozzarella 200g',60],
  ['جبنة دومتي قريش 250جم','Domty Cottage Cheese 250g',32],
  ['جبنة دومتي قريش 500جم','Domty Cottage Cheese 500g',58],
  ['جبنة دومتي رومي شرائح 200جم','Domty Roumi Slices 200g',75],
  ['جبنة دومتي مثلثات 8 قطع','Domty Triangles 8pc',28],
  ['جبنة دومتي مثلثات 16 قطعة','Domty Triangles 16pc',52],
  ['جبنة دومتي كريمي 240جم','Domty Cream Cheese 240g',55],
  ['جبنة دومتي كيري 8 قطع','Domty Kiri 8pc',45],
  ['جبنة دومتي قابلة للدهن 200جم','Domty Spreadable 200g',38],
], 103);

addMany([
  ['عصير لمار برتقال 1 لتر','Lamar Orange Juice 1L',32],
  ['عصير لمار مانجو 1 لتر','Lamar Mango Juice 1L',34],
  ['عصير لمار جوافة 1 لتر','Lamar Guava Juice 1L',33],
  ['عصير لمار كوكتيل 1 لتر','Lamar Cocktail Juice 1L',33],
  ['عصير لمار فراولة 1 لتر','Lamar Strawberry Juice 1L',34],
  ['عصير لمار رمان 1 لتر','Lamar Pomegranate Juice 1L',35],
  ['عصير لمار 250 مل برتقال','Lamar Orange 250ml',8],
  ['عصير لمار 250 مل مانجو','Lamar Mango 250ml',9],
  ['عصير لمار 250 مل تفاح','Lamar Apple 250ml',9],
  ['حليب لمار كامل الدسم 1 لتر','Lamar Full Cream Milk 1L',36],
  ['حليب لمار خالي الدسم 1 لتر','Lamar Skimmed Milk 1L',35],
  ['زبادي لمار 170جم','Lamar Yogurt 170g',11],
], 104);

addMany([
  ['حليب بيتي كامل الدسم 1 لتر','Beyti Full Cream Milk 1L',38],
  ['حليب بيتي خالي الدسم 1 لتر','Beyti Skimmed Milk 1L',37],
  ['حليب بيتي قليل الدسم 1 لتر','Beyti Low Fat Milk 1L',37],
  ['حليب بيتي بالشوكولاتة 200 مل','Beyti Chocolate Milk 200ml',12],
  ['عصير بيتي توتي فروتي 1 لتر','Beyti Tutti Frutti Juice 1L',32],
  ['عصير بيتي برتقال 1 لتر','Beyti Orange Juice 1L',32],
  ['عصير بيتي مانجو 1 لتر','Beyti Mango Juice 1L',34],
  ['عصير بيتي 235 مل برتقال','Beyti Orange 235ml',9],
  ['زبادي بيتي 170جم','Beyti Yogurt 170g',11],
  ['زبادي بيتي بالفواكه 170جم','Beyti Fruit Yogurt 170g',13],
], 105);

addMany([
  ['حليب المراعي طازج 1 لتر','Almarai Fresh Milk 1L',45],
  ['حليب المراعي قليل الدسم 1 لتر','Almarai Low Fat Milk 1L',45],
  ['حليب المراعي طويل الأجل 1 لتر','Almarai UHT Milk 1L',42],
  ['زبادي المراعي 170جم','Almarai Yogurt 170g',13],
  ['زبادي المراعي يوناني 150جم','Almarai Greek Yogurt 150g',19],
  ['لبنة المراعي 200جم','Almarai Labneh 200g',32],
  ['لبنة المراعي 400جم','Almarai Labneh 400g',58],
  ['قشطة المراعي 170جم','Almarai Cream 170g',26],
  ['زبدة المراعي 200جم','Almarai Butter 200g',55],
  ['زبدة المراعي 400جم','Almarai Butter 400g',105],
  ['عصير المراعي برتقال 1 لتر','Almarai Orange Juice 1L',38],
  ['عصير المراعي مانجو 1 لتر','Almarai Mango Juice 1L',40],
  ['جبنة المراعي مثلثات 8 قطع','Almarai Triangles 8pc',32],
  ['جبنة المراعي شيدر شرائح','Almarai Cheddar Slices',55],
], 106);

addMany([
  ['جبنة بريزيدنت موزاريلا 200جم','President Mozzarella 200g',75],
  ['جبنة بريزيدنت موزاريلا مبشورة 200جم','President Shredded Mozzarella 200g',80],
  ['زبدة بريزيدنت 200جم','President Butter 200g',95],
  ['زبدة بريزيدنت 400جم','President Butter 400g',180],
], 201);
addMany([['جبنة كرافت شيدر شرائح','Kraft Cheddar Slices',85]], 202);
addMany([
  ['جبنة كيري 8 مثلثات','Kiri 8 Triangles',48],
  ['جبنة كيري 16 مثلث','Kiri 16 Triangles',88],
], 203);
addMany([
  ['جبنة لافاش كير 8 قطع','La Vache qui Rit 8pc',38],
  ['جبنة لافاش كير 16 قطع','La Vache qui Rit 16pc',70],
  ['جبنة لافاش كير 24 قطع','La Vache qui Rit 24pc',95],
], 204);
addMany([['جبنة المرعى بيضاء 500جم','Greenland White Cheese 500g',72]], 205);
addMany([['جبنة بانوس كريمي 240جم','Panos Cream Cheese 240g',55]], 206);
addMany([
  ['جبنة فيلادلفيا 200جم','Philadelphia 200g',95],
  ['جبنة فيلادلفيا لايت 200جم','Philadelphia Light 200g',98],
], 207);
addMany([
  ['زبدة لورباك 200جم','Lurpak Butter 200g',125],
  ['زبدة لورباك 400جم','Lurpak Butter 400g',235],
], 208);
addMany([['زبدة بور دور 200جم','Pur Beurre 200g',95]], 209);

// ─── 2. BEVERAGES (~110) ───────────────────────────────────────────
addMany([
  ['كوكاكولا 1 لتر','Coca-Cola 1L',22],
  ['كوكاكولا 1.5 لتر','Coca-Cola 1.5L',28],
  ['كوكاكولا 2.5 لتر','Coca-Cola 2.5L',38],
  ['كوكاكولا 350 مل علبة','Coca-Cola 350ml Can',13],
  ['كوكاكولا 250 مل زجاج','Coca-Cola 250ml Glass',8],
  ['كوكاكولا دايت 1 لتر','Coca-Cola Diet 1L',22],
  ['كوكاكولا دايت 350 مل','Coca-Cola Diet 350ml',13],
  ['كوكاكولا زيرو 1 لتر','Coca-Cola Zero 1L',22],
  ['كوكاكولا زيرو 350 مل','Coca-Cola Zero 350ml',13],
  ['سبرايت 1 لتر','Sprite 1L',22],
  ['سبرايت 1.5 لتر','Sprite 1.5L',28],
  ['سبرايت 350 مل','Sprite 350ml',13],
  ['سبرايت 250 مل زجاج','Sprite 250ml Glass',8],
  ['فانتا برتقال 1 لتر','Fanta Orange 1L',22],
  ['فانتا برتقال 1.5 لتر','Fanta Orange 1.5L',28],
  ['فانتا برتقال 350 مل','Fanta Orange 350ml',13],
  ['فانتا فراولة 1 لتر','Fanta Strawberry 1L',22],
  ['فانتا فراولة 350 مل','Fanta Strawberry 350ml',13],
  ['فانتا تفاح 1 لتر','Fanta Apple 1L',22],
  ['فانتا تفاح 350 مل','Fanta Apple 350ml',13],
  ['شويبس صودا 1 لتر','Schweppes Soda 1L',22],
  ['شويبس صودا 350 مل','Schweppes Soda 350ml',13],
  ['شويبس مانجو 1 لتر','Schweppes Mango 1L',22],
  ['شويبس أناناس 1 لتر','Schweppes Pineapple 1L',22],
], 301);

addMany([
  ['بيبسي 1 لتر','Pepsi 1L',22],
  ['بيبسي 1.5 لتر','Pepsi 1.5L',28],
  ['بيبسي 2.5 لتر','Pepsi 2.5L',38],
  ['بيبسي 350 مل علبة','Pepsi 350ml Can',13],
  ['بيبسي 250 مل زجاج','Pepsi 250ml Glass',8],
  ['بيبسي دايت 1 لتر','Pepsi Diet 1L',22],
  ['بيبسي دايت 350 مل','Pepsi Diet 350ml',13],
  ['بيبسي ماكس 1 لتر','Pepsi Max 1L',22],
  ['بيبسي ماكس 350 مل','Pepsi Max 350ml',13],
  ['سفن أب 1 لتر','7Up 1L',22],
  ['سفن أب 1.5 لتر','7Up 1.5L',28],
  ['سفن أب 350 مل','7Up 350ml',13],
  ['ميرندا برتقال 1 لتر','Mirinda Orange 1L',22],
  ['ميرندا برتقال 1.5 لتر','Mirinda Orange 1.5L',28],
  ['ميرندا برتقال 350 مل','Mirinda Orange 350ml',13],
  ['ميرندا فراولة 1 لتر','Mirinda Strawberry 1L',22],
  ['ميرندا فراولة 350 مل','Mirinda Strawberry 350ml',13],
  ['ميرندا تفاح 1 لتر','Mirinda Apple 1L',22],
  ['ميرندا أناناس 1 لتر','Mirinda Pineapple 1L',22],
], 302);

addMany([
  ['مياه نستله 1.5 لتر','Nestle Pure Life 1.5L',8],
  ['مياه نستله 600 مل','Nestle Pure Life 600ml',5],
  ['مياه نستله 330 مل','Nestle Pure Life 330ml',3.5],
  ['مياه نستله 19 لتر جالون','Nestle Pure Life 19L',55],
], 303);
addMany([
  ['مياه دلتا 1.5 لتر','Delta 1.5L',7],
  ['مياه دلتا 600 مل','Delta 600ml',4],
], 304);
addMany([
  ['مياه حياة 1.5 لتر','Hayat 1.5L',7],
  ['مياه حياة 600 مل','Hayat 600ml',4],
], 305);
addMany([
  ['مياه أكوافينا 1.5 لتر','Aquafina 1.5L',8],
  ['مياه أكوافينا 600 مل','Aquafina 600ml',5],
], 306);
addMany([
  ['مياه بركة 1.5 لتر','Baraka 1.5L',7],
  ['مياه بركة 600 مل','Baraka 600ml',4],
], 307);
addMany([['مياه إيفيان 750 مل','Evian 750ml',38]], 308);
addMany([['مياه بيرير 750 مل','Perrier 750ml',45]], 309);

addMany([
  ['ريد بُل 250 مل','Red Bull 250ml',45],
  ['ريد بُل شوجر فري 250 مل','Red Bull Sugar Free 250ml',45],
], 310);
addMany([['مونستر طاقة 500 مل','Monster Energy 500ml',55]], 311);
addMany([['كود ريد 250 مل','Code Red 250ml',25]], 312);
addMany([['باور هورس 250 مل','Power Horse 250ml',32]], 313);
addMany([['XL طاقة 250 مل','XL Energy 250ml',22]], 314);

addMany([
  ['عصير فاروجلو برتقال 1 لتر','Faragello Orange 1L',28],
  ['عصير فاروجلو مانجو 1 لتر','Faragello Mango 1L',30],
  ['عصير فاروجلو جوافة 1 لتر','Faragello Guava 1L',29],
  ['عصير فاروجلو فراولة 1 لتر','Faragello Strawberry 1L',30],
  ['عصير فاروجلو كوكتيل 1 لتر','Faragello Cocktail 1L',29],
  ['عصير فاروجلو 235 مل برتقال','Faragello 235ml Orange',8],
  ['عصير فاروجلو 235 مل مانجو','Faragello 235ml Mango',9],
  ['عصير فاروجلو 235 مل تفاح','Faragello 235ml Apple',9],
  ['شراب فاروجلو ليمون','Faragello Lemon Syrup',45],
  ['شراب فاروجلو رمان','Faragello Pomegranate Syrup',48],
  ['شراب فاروجلو فراولة','Faragello Strawberry Syrup',45],
], 315);

addMany([
  ['بيرل أناناس 330 مل','Birell Pineapple 330ml',16],
  ['بيرل تفاح 330 مل','Birell Apple 330ml',16],
  ['بيرل عادي 330 مل','Birell Original 330ml',16],
  ['بيرل مانجو 330 مل','Birell Mango 330ml',16],
  ['بيرل رمان 330 مل','Birell Pomegranate 330ml',16],
  ['بيرل خوخ 330 مل','Birell Peach 330ml',16],
], 316);
addMany([
  ['فايروز أناناس 300 مل','Fayrouz Pineapple 300ml',14],
  ['فايروز تفاح 300 مل','Fayrouz Apple 300ml',14],
  ['فايروز رمان 300 مل','Fayrouz Pomegranate 300ml',14],
  ['فايروز خوخ 300 مل','Fayrouz Peach 300ml',14],
], 317);

// ─── 3. BISCUITS & SWEETS (~85) ────────────────────────────────────
addMany([
  ['توينكي إيديتا كيك بالكريم','Twinkie Edita Cream Cake',6],
  ['توينكي إيديتا شوكولاتة','Twinkie Edita Chocolate',6],
  ['توينكي إيديتا فراولة','Twinkie Edita Strawberry',6],
  ['هوهوز إيديتا كاكاو','HoHos Cocoa',7],
  ['هوهوز إيديتا فانيليا','HoHos Vanilla',7],
  ['موليتو إيديتا شوكولاتة','Molto Chocolate',8],
  ['موليتو إيديتا فراولة','Molto Strawberry',8],
  ['موليتو إيديتا كاسترد','Molto Custard',8],
  ['موليتو إيديتا كاكاو','Molto Cocoa',8],
  ['تودو إيديتا بسكويت شوكولاتة','Todo Chocolate',5],
  ['تودو إيديتا بسكويت فانيليا','Todo Vanilla',5],
  ['بيف إيديتا كيك شوكولاتة','Bake Rolz Chocolate',5],
  ['بيف إيديتا كيك فراولة','Bake Rolz Strawberry',5],
  ['بيك ستيكس إيديتا بيتزا','Bake Stix Pizza',8],
  ['بيك ستيكس إيديتا تشيز','Bake Stix Cheese',8],
  ['فريسكا إيديتا بسكويت بالكريم','Freska Cream Biscuit',7],
  ['ميمكس إيديتا كيك','Mimix Mini Cake',6],
], 401);

addMany([
  ['كورونا كاكاو بالحليب 30جم','Corona Milk Cocoa 30g',12],
  ['كورونا كاكاو فاخر 100جم','Corona Premium Cocoa 100g',32],
  ['كورونا حلوى بالحليب 30جم','Corona Milk Candy 30g',10],
  ['كورونا تكا تكا بالكاكاو','Corona Tika Cocoa',8],
  ['شوكولاتة كورونا بالبندق 30جم','Corona Hazelnut Chocolate 30g',14],
  ['شوكولاتة كورونا بالفول السوداني','Corona Peanut Chocolate',12],
  ['شوكولاتة كورونا بسكويت 25جم','Corona Biscuit Chocolate 25g',10],
  ['شوكولاتة كورونا كاكاو 100جم','Corona Cocoa Bar 100g',28],
], 402);

addMany([
  ['بسكو مصر شاي 60جم','Bisco Misr Tea 60g',5],
  ['بسكو مصر شاي عائلي 380جم','Bisco Misr Tea Family 380g',22],
  ['بسكو مصر بالشيكولاتة','Bisco Misr Chocolate',6],
  ['بسكو مصر بالحليب','Bisco Misr Milk',6],
  ['بسكو مصر بالقرفة','Bisco Misr Cinnamon',6],
  ['بسكو مصر بالكوكاو','Bisco Misr Cocoa',6],
  ['بسكو مصر بدون سكر','Bisco Misr Sugar Free',8],
  ['بسكو مصر بسكويت سوداني','Bisco Misr Peanut',6],
], 403);

addMany([
  ['شوكولاتة كادبوري دايري ميلك 37جم','Cadbury Dairy Milk 37g',22],
  ['شوكولاتة كادبوري دايري ميلك 90جم','Cadbury Dairy Milk 90g',55],
  ['شوكولاتة كادبوري بالبندق 90جم','Cadbury Hazelnut 90g',60],
  ['شوكولاتة كادبوري فلِك 30جم','Cadbury Flake 30g',18],
], 404);
addMany([
  ['شوكولاتة جالاكسي 36جم','Galaxy 36g',22],
  ['شوكولاتة جالاكسي 80جم','Galaxy 80g',48],
  ['شوكولاتة جالاكسي بالبندق 80جم','Galaxy Hazelnut 80g',52],
  ['شوكولاتة جالاكسي رايز 38جم','Galaxy Ripple 38g',22],
], 405);
addMany([
  ['شوكولاتة سنيكرز 50جم','Snickers 50g',22],
  ['شوكولاتة مارس 51جم','Mars 51g',22],
  ['شوكولاتة تويكس 50جم','Twix 50g',22],
  ['شوكولاتة باونتي 57جم','Bounty 57g',22],
], 406);
addMany([
  ['شوكولاتة كيت كات 41جم','Kit Kat 41g',22],
  ['شوكولاتة كيت كات شانكي','Kit Kat Chunky',25],
], 407);
addMany([
  ['شوكولاتة نوتيلا 350جم','Nutella 350g',225],
  ['شوكولاتة نوتيلا 200جم','Nutella 200g',140],
  ['شوكولاتة نوتيلا 750جم','Nutella 750g',420],
], 408);
addMany([
  ['شوكولاتة كيندر بوينو','Kinder Bueno',22],
  ['شوكولاتة كيندر سبرايز','Kinder Surprise',35],
  ['شوكولاتة كيندر شوكو بونز','Kinder Choco Bons',55],
], 409);
addMany([
  ['شوكولاتة فيريرو روشيه T16','Ferrero Rocher T16',195],
  ['شوكولاتة فيريرو روشيه T3','Ferrero Rocher T3',38],
], 410);
addMany([['شوكولاتة لاكتا فلفتا','Lacta Velvetta',25]], 411);
addMany([['شوكولاتة ميلكا بالحليب 100جم','Milka Milk 100g',58]], 412);
addMany([
  ['أوريو بسكويت 36جم','Oreo Biscuit 36g',8],
  ['أوريو بسكويت بالفراولة 36جم','Oreo Strawberry 36g',9],
  ['أوريو رول 25جم','Oreo Roll 25g',7],
], 413);

addMany([
  ['شيبسي مكرونة بالجبن','Chipsy Macaroni Cheese',7],
  ['شيبسي طماطم وجبن','Chipsy Tomato Cheese',7],
  ['شيبسي بطاطس مشوية','Chipsy Grilled Potato',7],
  ['شيبسي ملح','Chipsy Salt',7],
  ['شيبسي شطة','Chipsy Chili',7],
  ['شيبسي خل وملح','Chipsy Salt Vinegar',7],
  ['شيبسي عائلي مكرونة','Chipsy Family Macaroni',15],
  ['شيبسي عائلي ملح','Chipsy Family Salt',15],
], 501);
addMany([
  ['دوريتوس فلامين هوت','Doritos Flamin Hot',10],
  ['دوريتوس تشيز','Doritos Cheese',10],
  ['دوريتوس باربكيو','Doritos BBQ',10],
  ['دوريتوس عائلي تشيز','Doritos Family Cheese',22],
], 502);
addMany([
  ['تشيتوس كرات الجبن','Cheetos Cheese Balls',7],
  ['تشيتوس بفز شطة','Cheetos Puffs Chili',7],
  ['تشيتوس عائلي','Cheetos Family',15],
], 503);
addMany([
  ['ليز ملح','Lays Salt',7],
  ['ليز خل ملح','Lays Salt Vinegar',7],
  ['ليز شطة','Lays Chili',7],
  ['ليز كاتشاب','Lays Ketchup',7],
  ['ليز عائلي ملح','Lays Family Salt',15],
], 504);
addMany([
  ['تورتيلا قمح كامل','Tortilla Wheat',12],
  ['تورتيلا تشيلي','Tortilla Chili',12],
], 505);

// ─── 4. OILS & GHEE (~30) ──────────────────────────────────────────
addMany([
  ['زيت عافية عباد الشمس 1.6 لتر','Afia Sunflower Oil 1.6L',95],
  ['زيت عافية عباد الشمس 2.6 لتر','Afia Sunflower Oil 2.6L',155],
  ['زيت عافية عباد الشمس 800 مل','Afia Sunflower Oil 800ml',55],
  ['زيت عافية فول الصويا 1.6 لتر','Afia Soybean Oil 1.6L',92],
  ['زيت عافية ذرة 1.6 لتر','Afia Corn Oil 1.6L',105],
  ['سمن نباتي عافية 1 كيلو','Afia Vegetable Ghee 1Kg',135],
], 601);
addMany([
  ['زيت كريستال 1.6 لتر','Crystal Oil 1.6L',98],
  ['زيت كريستال 800 مل','Crystal Oil 800ml',54],
  ['زيت كريستال 2.6 لتر','Crystal Oil 2.6L',158],
  ['زيت زيتون كريستال 500 مل','Crystal Olive Oil 500ml',185],
  ['زيت زيتون كريستال 1 لتر','Crystal Olive Oil 1L',355],
  ['سمن نباتي كريستال 1 كيلو','Crystal Vegetable Ghee 1Kg',128],
], 602);
addMany([
  ['زيت السعودية ذرة 1.6 لتر','Saudia Corn Oil 1.6L',108],
  ['زيت السعودية عباد الشمس 1.6 لتر','Saudia Sunflower 1.6L',95],
], 603);
addMany([
  ['زيت روابي عباد الشمس 1.6 لتر','Rawabi Sunflower 1.6L',88],
  ['سمن صناعي روابي 1 كيلو','Rawabi Vegetable Ghee 1Kg',125],
], 604);
addMany([
  ['زيت سيرفل ذرة 1.6 لتر','Serval Corn Oil 1.6L',102],
  ['زيت سيرفل عباد الشمس 1.6 لتر','Serval Sunflower 1.6L',92],
], 605);
addMany([['زيت الطيب ذرة 1.6 لتر','Al Tayeb Corn 1.6L',105]], 606);
addMany([
  ['زيت السلطان فول الصويا 1.6 لتر','Sultan Soybean 1.6L',88],
  ['زيت السلطان عباد الشمس 1.6 لتر','Sultan Sunflower 1.6L',92],
], 607);
addMany([
  ['زيت زيتون ميلانو 500 مل','Milano Olive Oil 500ml',195],
  ['زيت زيتون ميلانو 1 لتر','Milano Olive Oil 1L',375],
], 608);
addMany([
  ['زيت زيتون النخبة 500 مل','Elite Olive Oil 500ml',175],
  ['زيت زيتون النخبة 1 لتر','Elite Olive Oil 1L',335],
], 609);
addMany([['زيت زيتون رحمة 500 مل','Rahma Olive Oil 500ml',165]], 610);
addMany([['زيت زيتون بكر 750 مل','Extra Virgin Olive 750ml',285]], 611);
addMany([['سمن طبيعي بلدنا 800جم','Baladna Ghee 800g',195]], 612);
addMany([['سمن جوست 1 كيلو','Goust Ghee 1Kg',132]], 613);

// ─── 5. RICE / PASTA / FLOUR (~55) ─────────────────────────────────
addMany([
  ['أرز الدوحة شعير 1 كيلو','El Doha Short Rice 1Kg',38],
  ['أرز الدوحة شعير 5 كيلو','El Doha Short Rice 5Kg',180],
  ['أرز الدوحة شعير 10 كيلو','El Doha Short Rice 10Kg',355],
  ['أرز الدوحة طويل 1 كيلو','El Doha Long Rice 1Kg',42],
  ['أرز الدوحة طويل 5 كيلو','El Doha Long Rice 5Kg',195],
  ['أرز الدوحة بسمتي 1 كيلو','El Doha Basmati 1Kg',55],
  ['أرز الدوحة مصري 1 كيلو','El Doha Egyptian 1Kg',36],
  ['دقيق الدوحة فاخر 1 كيلو','El Doha Premium Flour 1Kg',22],
  ['دقيق الدوحة فاخر 5 كيلو','El Doha Premium Flour 5Kg',105],
], 701);
addMany([
  ['مكرونة الملكة سباجيتي','El Malika Spaghetti',12],
  ['مكرونة الملكة بيني','El Malika Penne',12],
  ['مكرونة الملكة فيتشيني','El Malika Fettuccine',12],
  ['مكرونة الملكة مكرونة قصيرة','El Malika Short Pasta',11],
  ['مكرونة الملكة شعرية','El Malika Vermicelli',9],
  ['مكرونة الملكة لازانيا','El Malika Lasagna',22],
  ['مكرونة الملكة فراشة','El Malika Bowtie',13],
  ['مكرونة الملكة قشر بيضة','El Malika Egg Shell',13],
], 702);
addMany([
  ['مكرونة رجينا سباجيتي','Regina Spaghetti',14],
  ['مكرونة رجينا بيني','Regina Penne',14],
  ['مكرونة رجينا فيتشيني','Regina Fettuccine',14],
  ['مكرونة رجينا لازانيا','Regina Lasagna',25],
], 703);
addMany([
  ['أرز رشيدي الميزان 1 كيلو','El Rashidi Rice 1Kg',38],
  ['دقيق رشيدي الميزان 1 كيلو','El Rashidi Flour 1Kg',23],
  ['طحينة رشيدي الميزان 400جم','El Rashidi Tahina 400g',55],
  ['طحينة رشيدي الميزان 800جم','El Rashidi Tahina 800g',105],
  ['حلاوة طحينية رشيدي الميزان 450جم','El Rashidi Halawa 450g',75],
  ['حلاوة طحينية رشيدي الميزان بالبندق','El Rashidi Halawa Hazelnut',85],
  ['دبس رشيدي الميزان 700جم','El Rashidi Molasses 700g',55],
], 704);
addMany([
  ['أرز الأمير 1 كيلو','El Amir Rice 1Kg',36],
  ['أرز الأمير 5 كيلو','El Amir Rice 5Kg',175],
], 705);
addMany([
  ['دقيق الراية فاخر 1 كيلو','Al Raya Flour 1Kg',22],
  ['سميد الراية 1 كيلو','Al Raya Semolina 1Kg',24],
], 706);
addMany([
  ['برغل الإمتياز ناعم 500جم','Imtiyaz Fine Bulgur 500g',18],
  ['برغل الإمتياز خشن 500جم','Imtiyaz Coarse Bulgur 500g',18],
  ['فريك الإمتياز 500جم','Imtiyaz Freekeh 500g',22],
  ['كسكسي الإمتياز 500جم','Imtiyaz Couscous 500g',20],
  ['شعرية الإمتياز','Imtiyaz Vermicelli',9],
], 707);
addMany([
  ['عدس أصفر 1 كيلو','Yellow Lentils 1Kg',45],
  ['عدس أحمر 1 كيلو','Red Lentils 1Kg',48],
  ['عدس أسود 1 كيلو','Black Lentils 1Kg',52],
  ['فول مدمس 1 كيلو','Fava Beans 1Kg',35],
  ['فاصوليا بيضاء 1 كيلو','White Beans 1Kg',45],
  ['لوبيا 1 كيلو','Black-eyed Peas 1Kg',48],
  ['حمص 1 كيلو','Chickpeas 1Kg',55],
], 708);

// ─── 6. TEA / COFFEE (~55) ─────────────────────────────────────────
addMany([
  ['شاي العربي 100 فتلة','Al Arabi Tea 100 Bags',38],
  ['شاي العربي 50 فتلة','Al Arabi Tea 50 Bags',22],
  ['شاي العربي 100جم سايب','Al Arabi Loose Tea 100g',18],
  ['شاي العربي 250جم سايب','Al Arabi Loose Tea 250g',42],
  ['شاي العربي 500جم سايب','Al Arabi Loose Tea 500g',82],
  ['شاي العربي إيرل جراي','Al Arabi Earl Grey',28],
  ['شاي العربي بالنعناع','Al Arabi Mint Tea',28],
  ['شاي العربي بالقرفة','Al Arabi Cinnamon Tea',28],
  ['شاي العربي أخضر','Al Arabi Green Tea',32],
], 801);
addMany([
  ['شاي ليبتون 100 فتلة','Lipton Tea 100 Bags',45],
  ['شاي ليبتون 50 فتلة','Lipton Tea 50 Bags',25],
  ['شاي ليبتون أصفر سايب 250جم','Lipton Yellow Loose 250g',48],
  ['شاي ليبتون أصفر سايب 500جم','Lipton Yellow Loose 500g',95],
  ['شاي ليبتون إيرل جراي','Lipton Earl Grey',32],
  ['شاي ليبتون أخضر فاميلي','Lipton Green Family',35],
  ['شاي ليبتون بالليمون','Lipton Lemon',32],
  ['شاي ليبتون بالنعناع','Lipton Mint',32],
], 802);
addMany([
  ['شاي العوضي 250جم','El Awadi Tea 250g',38],
  ['شاي العوضي 500جم','El Awadi Tea 500g',75],
  ['شاي العوضي 100جم','El Awadi Tea 100g',16],
], 803);
addMany([
  ['شاي التوحيد 100جم','El Tawheed Tea 100g',15],
  ['شاي التوحيد 250جم','El Tawheed Tea 250g',35],
  ['شاي التوحيد 500جم','El Tawheed Tea 500g',68],
], 804);
addMany([
  ['نسكافيه كلاسيك 50جم','Nescafe Classic 50g',55],
  ['نسكافيه كلاسيك 100جم','Nescafe Classic 100g',105],
  ['نسكافيه كلاسيك 200جم','Nescafe Classic 200g',195],
  ['نسكافيه جولد 50جم','Nescafe Gold 50g',95],
  ['نسكافيه جولد 100جم','Nescafe Gold 100g',185],
  ['نسكافيه جولد 200جم','Nescafe Gold 200g',345],
  ['نسكافيه 3 في 1','Nescafe 3in1',5],
  ['نسكافيه 3 في 1 علبة 24','Nescafe 3in1 Box 24',95],
  ['نسكافيه كابتشينو موكا','Nescafe Cappuccino Mocha',8],
  ['نسكافيه كابتشينو فانيليا','Nescafe Cappuccino Vanilla',8],
  ['نسكافيه كابتشينو كاراميل','Nescafe Cappuccino Caramel',8],
], 805);
addMany([
  ['قهوة أبو عوف تركي 200جم','Abu Auf Turkish Coffee 200g',55],
  ['قهوة أبو عوف تركي 500جم','Abu Auf Turkish Coffee 500g',125],
  ['قهوة أبو عوف عربي 200جم','Abu Auf Arabic Coffee 200g',58],
  ['قهوة أبو عوف فرنساوي 200جم','Abu Auf French Coffee 200g',65],
  ['قهوة أبو عوف بالهيل 200جم','Abu Auf Cardamom Coffee 200g',62],
  ['قهوة أبو عوف اسبريسو 200جم','Abu Auf Espresso 200g',72],
], 806);
addMany([
  ['قهوة العميد تركي 200جم','El Amid Turkish 200g',48],
  ['قهوة العميد بالهيل 200جم','El Amid Cardamom 200g',55],
], 807);
addMany([
  ['كوفي ميت 400جم','Coffee Mate 400g',75],
  ['كوفي ميت 200جم','Coffee Mate 200g',42],
], 808);

// ─── 7. CANNED & SAUCES (~55) ──────────────────────────────────────
addMany([
  ['كاتشاب هاينز 460جم','Heinz Ketchup 460g',55],
  ['كاتشاب هاينز 1 كيلو','Heinz Ketchup 1Kg',105],
  ['مايونيز هاينز 460جم','Heinz Mayonnaise 460g',58],
  ['مايونيز هاينز 1 كيلو','Heinz Mayonnaise 1Kg',115],
  ['مايونيز هاينز لايت 460جم','Heinz Light Mayo 460g',62],
  ['صلصة هاينز شطة','Heinz Hot Sauce',45],
  ['صلصة هاينز باربكيو','Heinz BBQ Sauce',55],
  ['صلصة هاينز رنش','Heinz Ranch',58],
  ['صلصة هاينز ثاوزند آيلاند','Heinz Thousand Island',58],
  ['خل تفاح هاينز 500 مل','Heinz Apple Vinegar 500ml',32],
  ['خل أبيض هاينز 500 مل','Heinz White Vinegar 500ml',28],
], 901);
addMany([
  ['كاتشاب أمريكانا 460جم','Americana Ketchup 460g',38],
  ['مايونيز أمريكانا 460جم','Americana Mayonnaise 460g',42],
  ['شطة أمريكانا','Americana Chili',32],
  ['تونة أمريكانا في الزيت 160جم','Americana Tuna Oil 160g',32],
  ['تونة أمريكانا في الماء 160جم','Americana Tuna Water 160g',32],
  ['تونة أمريكانا بالشطة 160جم','Americana Tuna Chili 160g',34],
  ['تونة أمريكانا فلكية 160جم','Americana Tuna Premium 160g',38],
  ['سردين أمريكانا 125جم','Americana Sardines 125g',22],
  ['كرات لحم أمريكانا','Americana Meatballs',95],
  ['برجر أمريكانا 4 قطع','Americana Burger 4pc',75],
  ['كباب أمريكانا','Americana Kebab',88],
  ['فرانك أمريكانا','Americana Frank',45],
], 902);
addMany([
  ['تونة فاين فود في الزيت 160جم','Fine Food Tuna Oil 160g',28],
  ['تونة فاين فود في الماء 160جم','Fine Food Tuna Water 160g',28],
  ['تونة فاين فود قطع 160جم','Fine Food Tuna Chunks 160g',32],
  ['سردين فاين فود','Fine Food Sardines',20],
], 903);
addMany([
  ['تونة كاندي في الزيت 160جم','Candy Tuna Oil 160g',26],
  ['تونة كاندي في الماء 160جم','Candy Tuna Water 160g',26],
  ['سردين كاندي','Candy Sardines',18],
], 904);
addMany([
  ['ذرة كاليفورنيا 340جم','California Corn 340g',28],
  ['ذرة كاليفورنيا 425جم','California Corn 425g',35],
  ['بازلاء كاليفورنيا','California Peas',32],
  ['فاصوليا خضراء كاليفورنيا','California Green Beans',35],
  ['فطر كاليفورنيا 200جم','California Mushroom 200g',38],
  ['زيتون أخضر كاليفورنيا','California Green Olives',45],
  ['زيتون أسود كاليفورنيا','California Black Olives',48],
  ['مخلل خيار كاليفورنيا','California Pickles',38],
], 905);
addMany([
  ['صلصة طماطم المصرية 400جم','Egyptian Tomato Sauce 400g',16],
  ['صلصة طماطم المصرية 800جم','Egyptian Tomato Sauce 800g',28],
  ['معجون طماطم المصرية 380جم','Egyptian Tomato Paste 380g',22],
], 906);
addMany([
  ['زبادي خل تمرات 250جم','Date Vinegar 250g',22],
  ['زبادي بلح المدينة 500جم','Madinah Dates 500g',55],
  ['زبادي بلح المجدول 500جم','Medjool Dates 500g',125],
], 907);

// ─── 8. CLEANERS / HOUSEHOLD (~55) ────────────────────────────────
addMany([
  ['آريال مسحوق غسيل 2.5 كيلو','Ariel Powder 2.5Kg',155],
  ['آريال مسحوق غسيل 4.5 كيلو','Ariel Powder 4.5Kg',265],
  ['آريال مسحوق غسيل 9 كيلو','Ariel Powder 9Kg',495],
  ['آريال سائل غسيل 2 لتر','Ariel Liquid 2L',135],
  ['آريال جل مركز 1.4 لتر','Ariel Gel 1.4L',125],
  ['آريال أطفال 2.5 كيلو','Ariel Baby 2.5Kg',165],
  ['تايد مسحوق غسيل 3 كيلو','Tide Powder 3Kg',185],
  ['تايد سائل غسيل 1.85 لتر','Tide Liquid 1.85L',125],
], 1001);
addMany([
  ['برسيل مسحوق غسيل 2.25 كيلو','Persil Powder 2.25Kg',145],
  ['برسيل مسحوق غسيل 4.5 كيلو','Persil Powder 4.5Kg',255],
  ['برسيل مسحوق غسيل 9 كيلو','Persil Powder 9Kg',485],
  ['برسيل جل مركز 1.5 لتر','Persil Gel 1.5L',135],
  ['برسيل أطفال 2.25 كيلو','Persil Baby 2.25Kg',155],
], 1002);
addMany([
  ['داون سائل أطباق 750 مل','Dawn Dish Liquid 750ml',38],
  ['داون سائل أطباق 1.5 لتر','Dawn Dish Liquid 1.5L',68],
], 1003);
addMany([
  ['فيري سائل أطباق 750 مل','Fairy Dish Liquid 750ml',42],
  ['فيري سائل أطباق 1.5 لتر','Fairy Dish Liquid 1.5L',75],
  ['فيري سائل أطباق ليمون 750 مل','Fairy Lemon 750ml',42],
  ['فيري سائل أطباق تفاح 750 مل','Fairy Apple 750ml',42],
], 1004);
addMany([
  ['بريل سائل أطباق 500 مل','Pril Dish Liquid 500ml',22],
  ['بريل سائل أطباق 1 لتر','Pril Dish Liquid 1L',38],
  ['بريل ليمون 1 لتر','Pril Lemon 1L',38],
], 1005);
addMany([
  ['كلوركس مبيض 1.42 لتر','Clorox Bleach 1.42L',38],
  ['كلوركس مبيض 2.84 لتر','Clorox Bleach 2.84L',72],
  ['كلوركس جل 720 مل','Clorox Gel 720ml',32],
  ['كلوركس أطباق','Clorox Dish',28],
], 1006);
addMany([
  ['ديتول سائل تعقيم 250 مل','Dettol Antiseptic 250ml',38],
  ['ديتول سائل تعقيم 500 مل','Dettol Antiseptic 500ml',65],
  ['ديتول سائل تعقيم 1 لتر','Dettol Antiseptic 1L',115],
  ['ديتول صابون أصلي','Dettol Original Soap',12],
  ['ديتول صابون كول','Dettol Cool Soap',12],
], 1007);
addMany([
  ['ميستر مسلم منظف أرضيات','Mr Muscle Floor Cleaner',55],
  ['ميستر مسلم منظف زجاج','Mr Muscle Glass Cleaner',45],
  ['ميستر مسلم منظف فرن','Mr Muscle Oven Cleaner',55],
  ['ميستر مسلم منظف حمام','Mr Muscle Bathroom Cleaner',52],
], 1008);
addMany([
  ['فلاش منظف أرضيات 1.25 لتر','Flash Floor 1.25L',45],
  ['فلاش منظف أرضيات 4 لتر','Flash Floor 4L',135],
  ['فلاش ليمون 1.25 لتر','Flash Lemon 1.25L',45],
  ['فلاش لافندر 1.25 لتر','Flash Lavender 1.25L',45],
], 1009);
addMany([
  ['ديو روم معطر جو لافندر','Air Wick Lavender',48],
  ['ديو روم معطر جو ورد','Air Wick Rose',48],
  ['جلاد كيس قمامة 50 لتر','Glad Garbage Bag 50L',32],
  ['جلاد كيس قمامة 80 لتر','Glad Garbage Bag 80L',45],
  ['فويل ألومنيوم 20 متر','Aluminum Foil 20m',28],
  ['كلينج فيلم 30 متر','Cling Film 30m',32],
], 1010);

// ─── 9. PERSONAL CARE (~55) ────────────────────────────────────────
addMany([
  ['شامبو لوكس ورد 400 مل','Lux Rose Shampoo 400ml',55],
  ['شامبو لوكس ياسمين 400 مل','Lux Jasmine Shampoo 400ml',55],
  ['صابون لوكس ورد','Lux Rose Soap',12],
  ['صابون لوكس فل','Lux Jasmine Soap',12],
  ['صابون لوكس أخضر','Lux Green Soap',12],
  ['دش لوكس 250 مل','Lux Shower Gel 250ml',45],
], 1101);
addMany([
  ['صابون لايف بوي أحمر','Lifebuoy Red Soap',10],
  ['صابون لايف بوي طوطل','Lifebuoy Total Soap',10],
  ['صابون لايف بوي كير','Lifebuoy Care Soap',10],
  ['دش لايف بوي 250 مل','Lifebuoy Shower 250ml',38],
  ['شامبو لايف بوي 400 مل','Lifebuoy Shampoo 400ml',45],
], 1102);
addMany([
  ['معجون كلوس أب 100 مل','Close Up 100ml',25],
  ['معجون كلوس أب 50 مل','Close Up 50ml',15],
  ['معجون كلوس أب ريد هوت','Close Up Red Hot',25],
  ['معجون كلوس أب وايت أتاك','Close Up White Attack',28],
], 1103);
addMany([
  ['معجون سيجنال 100 مل','Signal 100ml',28],
  ['معجون سيجنال 50 مل','Signal 50ml',16],
  ['معجون سيجنال أبيض','Signal White',32],
  ['معجون سيجنال نعناع','Signal Mint',28],
], 1104);
addMany([
  ['معجون كولجيت 100 مل','Colgate 100ml',32],
  ['معجون كولجيت 50 مل','Colgate 50ml',18],
  ['معجون كولجيت توتال','Colgate Total',38],
  ['معجون كولجيت سنسيتيف','Colgate Sensitive',45],
  ['فرشاة أسنان كولجيت متوسطة','Colgate Toothbrush Medium',18],
  ['فرشاة أسنان كولجيت طرية','Colgate Toothbrush Soft',18],
], 1105);
addMany([
  ['شامبو هيد آند شولدرز 200 مل','Head & Shoulders 200ml',55],
  ['شامبو هيد آند شولدرز 400 مل','Head & Shoulders 400ml',95],
  ['شامبو هيد آند شولدرز 600 مل','Head & Shoulders 600ml',135],
  ['شامبو هيد آند شولدرز ضد القشرة 400','Head & Shoulders Anti Dandruff 400',95],
], 1106);
addMany([
  ['شامبو بانتين 200 مل','Pantene 200ml',55],
  ['شامبو بانتين 400 مل','Pantene 400ml',95],
  ['بلسم بانتين 200 مل','Pantene Conditioner 200ml',58],
  ['ماسك بانتين','Pantene Mask',85],
], 1107);
addMany([
  ['مزيل عرق ركسونا 150 مل','Rexona Deo 150ml',45],
  ['مزيل عرق ركسونا روول 50 مل','Rexona Roll 50ml',32],
  ['مزيل عرق نيفيا 150 مل','Nivea Deo 150ml',48],
  ['مزيل عرق دوف 150 مل','Dove Deo 150ml',55],
  ['كريم نيفيا 100 مل','Nivea Cream 100ml',38],
  ['كريم نيفيا 250 مل','Nivea Cream 250ml',85],
  ['كريم وجه نيفيا','Nivea Face Cream',95],
  ['غسول وجه نيفيا','Nivea Face Wash',75],
], 1108);
addMany([
  ['شفرات حلاقة جيليت 5 شفرات','Gillette 5 Blades',55],
  ['شفرات حلاقة جيليت بيك 10','Gillette Pack 10',125],
  ['كريم حلاقة جيليت','Gillette Shave Cream',95],
  ['شفرات بيك 10 قطع','Bic Blades 10pc',55],
], 1109);
addMany([
  ['فوط كوتكس 10 قطع','Kotex 10pc',38],
  ['فوط ألويز 10 قطع','Always 10pc',45],
  ['فوط ألويز ليلي 10 قطع','Always Night 10pc',55],
  ['حفاضات بامبرز مقاس 3','Pampers Size 3',125],
  ['حفاضات بامبرز مقاس 4','Pampers Size 4',135],
  ['حفاضات بامبرز مقاس 5','Pampers Size 5',145],
  ['حفاضات هاجيز مقاس 3','Huggies Size 3',115],
  ['حفاضات هاجيز مقاس 4','Huggies Size 4',125],
], 1110);

// ─── 10. BREAKFAST & HOT DRINKS (~35) ──────────────────────────────
addMany([
  ['كورن فليكس كيلوجز 375جم','Kelloggs Corn Flakes 375g',95],
  ['كورن فليكس كيلوجز 500جم','Kelloggs Corn Flakes 500g',125],
  ['كوكو بوبس كيلوجز 375جم','Kelloggs Coco Pops 375g',105],
  ['تشوكوس كيلوجز 375جم','Kelloggs Choco 375g',105],
  ['فروتي لوبس كيلوجز','Kelloggs Froot Loops',115],
  ['فروستيس كيلوجز','Kelloggs Frosties',95],
], 1201);
addMany([
  ['كورن فليكس بوست 500جم','Post Corn Flakes 500g',98],
  ['شريحة بوست','Post Pops',95],
], 1202);
addMany([
  ['شوفان كويكر 500جم','Quaker Oats 500g',55],
  ['شوفان كويكر 1 كيلو','Quaker Oats 1Kg',95],
  ['شوفان كويكر سريع التحضير','Quaker Instant Oats',32],
  ['شوفان كويكر فواكه','Quaker Fruit Oats',38],
  ['شوفان كويكر بالعسل','Quaker Honey Oats',38],
], 1203);
addMany([
  ['هوت شوكليت كادبوري 250جم','Cadbury Hot Chocolate 250g',125],
  ['هوت شوكليت نسلي 250جم','Nestle Hot Chocolate 250g',125],
  ['نسكويك 400جم','Nesquik 400g',95],
  ['نسكويك 1 كيلو','Nesquik 1Kg',185],
  ['أوفلتين 400جم','Ovaltine 400g',105],
  ['أوفلتين 800جم','Ovaltine 800g',195],
  ['ميلو 400جم','Milo 400g',95],
  ['ميلو 1 كيلو','Milo 1Kg',195],
], 1204);
addMany([
  ['عسل أبيض النحال 800جم','Al Nahhal Honey 800g',155],
  ['عسل أبيض النحال 400جم','Al Nahhal Honey 400g',85],
  ['عسل سدر الصافي 250جم','Al Safi Sidr Honey 250g',225],
  ['مربى فيتراك مشمش 350جم','Vitrac Apricot Jam 350g',45],
  ['مربى فيتراك فراولة 350جم','Vitrac Strawberry Jam 350g',45],
  ['مربى فيتراك تين 350جم','Vitrac Fig Jam 350g',55],
  ['مربى فيتراك جوافة 350جم','Vitrac Guava Jam 350g',45],
], 1205);
addMany([
  ['زبدة الفول السوداني سكيبي 340جم','Skippy Peanut Butter 340g',95],
  ['زبدة الفول السوداني سكيبي 510جم','Skippy Peanut Butter 510g',145],
], 1206);

// ─── 11. INSTANT NOODLES / SNACKS (~45) ────────────────────────────
addMany([
  ['إندومي دجاج','Indomie Chicken',6],
  ['إندومي خضار','Indomie Vegetable',6],
  ['إندومي شواية','Indomie BBQ',6],
  ['إندومي ميجوار','Indomie Mi Goreng',8],
  ['إندومي عائلي دجاج','Indomie Family Chicken',28],
  ['إندومي عائلي خضار','Indomie Family Vegetable',28],
  ['إندومي عائلي شواية','Indomie Family BBQ',28],
  ['إندومي كاسة دجاج','Indomie Cup Chicken',12],
  ['إندومي كاسة بيف','Indomie Cup Beef',12],
  ['إندومي كاسة ميجوار','Indomie Cup Mi Goreng',14],
], 1301);
addMany([
  ['ميجي دجاج','Maggi Chicken',5],
  ['ميجي خضار','Maggi Vegetable',5],
  ['ميجي مكعبات دجاج 24','Maggi Chicken Cubes 24',32],
  ['ميجي مكعبات خضار 24','Maggi Vegetable Cubes 24',32],
  ['ميجي شوربة دجاج','Maggi Chicken Soup',8],
  ['ميجي شوربة عدس','Maggi Lentil Soup',8],
  ['ميجي شوربة فطر','Maggi Mushroom Soup',8],
  ['ميجي شوربة طماطم','Maggi Tomato Soup',8],
], 1302);
addMany([
  ['كنور مكعبات دجاج 24','Knorr Chicken Cubes 24',35],
  ['كنور مكعبات خضار 24','Knorr Vegetable Cubes 24',35],
  ['كنور شوربة دجاج بالنودلز','Knorr Chicken Noodle Soup',10],
  ['كنور شوربة عدس','Knorr Lentil Soup',9],
  ['كنور شوربة فطر','Knorr Mushroom Soup',10],
  ['كنور بشاميل مكس','Knorr Bechamel Mix',22],
], 1303);
addMany([
  ['بوب كورن جاهز كاراميل 80جم','Caramel Popcorn 80g',12],
  ['بوب كورن جاهز جبن 80جم','Cheese Popcorn 80g',12],
  ['بوب كورن جاهز ملح 80جم','Salt Popcorn 80g',10],
  ['بوب كورن مايكروويف زبدة','Microwave Butter Popcorn',18],
  ['ذرة بوب كورن خام 500جم','Popcorn Kernels 500g',32],
], 1304);
addMany([
  ['فول سوداني محمص 200جم','Roasted Peanuts 200g',22],
  ['لب سوبر 100جم','Super Seeds 100g',8],
  ['لب سوبر شامي 100جم','Super Sunflower 100g',8],
  ['مكسرات فاخرة 250جم','Premium Nuts 250g',125],
  ['كاجو محمص 250جم','Roasted Cashew 250g',155],
  ['لوز محمص 250جم','Roasted Almonds 250g',135],
  ['فستق محمص 250جم','Roasted Pistachio 250g',225],
], 1305);

// ─── 12. ICE CREAM (~35) ───────────────────────────────────────────
addMany([
  ['آيس كريم كوارتلي فانيليا','Quartely Vanilla',55],
  ['آيس كريم كوارتلي شوكولاتة','Quartely Chocolate',55],
  ['آيس كريم كوارتلي فراولة','Quartely Strawberry',55],
  ['آيس كريم كوارتلي مانجو','Quartely Mango',58],
  ['آيس كريم كوارتلي كوكتيل','Quartely Cocktail',58],
  ['كريز جيلاتي ميكس فروت','Crize Mixed Fruit',12],
  ['كريز جيلاتي شوكولاتة','Crize Chocolate',12],
  ['كريز جيلاتي فراولة','Crize Strawberry',12],
], 1401);
addMany([
  ['آيس كريم نستله سموك','Nestle Smoothie',15],
  ['آيس كريم نستله موفنبيك فانيليا','Movenpick Vanilla',85],
  ['آيس كريم نستله موفنبيك شوكولاتة','Movenpick Chocolate',85],
  ['آيس كريم نستله موفنبيك فراولة','Movenpick Strawberry',85],
  ['آيس كريم نستله موفنبيك بستاشيو','Movenpick Pistachio',95],
  ['كيت كات آيس كريم','Kit Kat Ice Cream',18],
  ['أوريو آيس كريم','Oreo Ice Cream',18],
  ['ماجنوم كلاسيك','Magnum Classic',32],
  ['ماجنوم ألموند','Magnum Almond',32],
  ['ماجنوم وايت','Magnum White',32],
  ['ماجنوم دبل كاراميل','Magnum Double Caramel',35],
  ['كورنيتو فانيليا','Cornetto Vanilla',18],
  ['كورنيتو شوكولاتة','Cornetto Chocolate',18],
  ['كورنيتو فراولة','Cornetto Strawberry',18],
  ['كرانش بنانا','Crunch Banana',12],
  ['كرانش شوكو','Crunch Choco',12],
], 1402);
addMany([
  ['آيس كريم ميستر بطاطس فانيليا','Mister Patatas Vanilla',8],
  ['آيس كريم ميستر بطاطس فراولة','Mister Patatas Strawberry',8],
  ['عصاية مانجو فيرونا','Verona Mango Stick',6],
  ['عصاية تمر هندي فيرونا','Verona Tamarind Stick',6],
  ['ثلج 5 كيلو','Ice 5Kg',22],
  ['ثلج 10 كيلو','Ice 10Kg',38],
], 1403);

// ─── Write CSV ─────────────────────────────────────────────────────
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
// UTF-8 BOM so Excel opens Arabic correctly
const out = path.join('attached_assets', 'grocery_items_egypt.csv');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '\uFEFF' + csv, 'utf8');

console.log(`Total items: ${rows.length - 1}`);
console.log(`Output: ${out}`);
console.log(`Size: ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
console.log('Sample first 3 data rows:');
for (let i = 1; i <= 3; i++) console.log('  ', rows[i].join(' | '));
console.log('Sample last 3 data rows:');
for (let i = rows.length - 3; i < rows.length; i++) console.log('  ', rows[i].join(' | '));
