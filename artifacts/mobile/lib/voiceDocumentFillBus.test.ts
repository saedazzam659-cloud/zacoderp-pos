import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emitVoiceDocumentSave,
  normalizeVoiceFillText,
  parseVoiceDateValue,
  parseVoiceFillNumbers,
  subscribeVoiceDocumentSave,
} from './voiceDocumentFillBus';

test('normalizes Arabic digits and hamza variants for local catalog matching', () => {
  assert.equal(normalizeVoiceFillText('أضف ٣ من السكر'), 'اضف 3 من السكر');
});

test('extracts a requested quantity and price from Arabic speech text', () => {
  assert.deepEqual(parseVoiceFillNumbers('أضف ٣ قطع من السكر بسعر ١٢٫٥'), {
    quantity: 3,
    unitPrice: 12.5,
  });
});

test('does not invent a quantity or price when they were not spoken', () => {
  const result = parseVoiceFillNumbers('العميل أحمد');
  assert.equal(result.quantity, undefined);
  assert.equal(result.unitPrice, undefined);
});

test('normalizes explicit Arabic invoice dates and rejects invalid dates', () => {
  assert.equal(parseVoiceDateValue('تاريخ الفاتورة ١٧/١٠/٢٠٢٦'), '2026-10-17');
  assert.equal(parseVoiceDateValue('2026-02-30'), undefined);
});

test('voice save is dispatched only when an active form allows it', () => {
  assert.equal(emitVoiceDocumentSave(), false);
  const unsubscribe = subscribeVoiceDocumentSave(() => true);
  assert.equal(emitVoiceDocumentSave(), true);
  unsubscribe();
  assert.equal(emitVoiceDocumentSave(), false);
});
