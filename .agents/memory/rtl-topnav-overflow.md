---
name: RTL top navigation overflow
description: Enabled module groups must remain visibly discoverable in the desktop RTL top navigation.
---

The desktop RTL top navigation must wrap enabled module groups instead of placing them in an unmarked horizontal overflow area.

**Why:** At common laptop widths, later groups such as Fixed Assets existed in the DOM with valid permissions but loaded beyond the left viewport edge. Users reasonably interpreted the clipped item as a failed permission grant because no scrollbar or overflow cue was visible.

**How to apply:** Keep the top-navigation group container wrapping across rows. When adding groups or changing its layout, verify the last enabled group has a fully visible bounding box at 1024px width in RTL.