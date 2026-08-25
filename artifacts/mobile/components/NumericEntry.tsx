import React, { useEffect, useState } from 'react';
import { TextInput } from 'react-native';

export function NumericEntry({
  value,
  onChangeValue,
  blankWhenZero = true,
  blankWhenOne = false,
  emptyValue,
  testID,
  style,
}: {
  value: number;
  onChangeValue: (value: number) => void;
  blankWhenZero?: boolean;
  blankWhenOne?: boolean;
  emptyValue?: number;
  testID?: string;
  style?: React.ComponentProps<typeof TextInput>['style'];
}) {
  const hiddenAtRest =
    (blankWhenZero && value === 0) ||
    (blankWhenOne && value === 1);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(() => hiddenAtRest ? '' : String(value));
  const lastCommittedValue = React.useRef(value);

  useEffect(() => {
    if (!focused || value !== lastCommittedValue.current) {
      setDraft(String(value));
      lastCommittedValue.current = value;
    }
  }, [focused, value]);

  const handleFocus = () => {
    lastCommittedValue.current = value;
    setDraft(hiddenAtRest ? '' : String(value));
    setFocused(true);
  };

  const handleChangeText = (raw: string) => {
    const clean = raw.replace(/[^\d.]/g, '');
    setDraft(clean);
    if (clean === '') {
      if (emptyValue !== undefined) {
        lastCommittedValue.current = emptyValue;
        onChangeValue(emptyValue);
      }
      return;
    }
    const parsed = parseFloat(clean);
    if (Number.isFinite(parsed)) {
      lastCommittedValue.current = parsed;
      onChangeValue(parsed);
    }
  };

  return (
    <TextInput
      testID={testID}
      value={focused ? draft : (hiddenAtRest ? '' : String(value))}
      keyboardType="decimal-pad"
      onFocus={handleFocus}
      onBlur={() => setFocused(false)}
      onChangeText={handleChangeText}
      style={style}
    />
  );
}