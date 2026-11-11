export interface SelectionBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DragSelection {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function normalizeDragSelection(selection: DragSelection): SelectionBounds {
  return {
    left: Math.min(selection.x1, selection.x2),
    top: Math.min(selection.y1, selection.y2),
    right: Math.max(selection.x1, selection.x2),
    bottom: Math.max(selection.y1, selection.y2),
  };
}

export function selectionIntersects(
  selection: SelectionBounds,
  target: SelectionBounds,
): boolean {
  return selection.left < target.right
    && selection.right > target.left
    && selection.top < target.bottom
    && selection.bottom > target.top;
}

export function selectionContainsCenter(
  selection: SelectionBounds,
  target: SelectionBounds,
): boolean {
  const centerX = (target.left + target.right) / 2;
  const centerY = (target.top + target.bottom) / 2;
  return centerX >= selection.left
    && centerX <= selection.right
    && centerY >= selection.top
    && centerY <= selection.bottom;
}
