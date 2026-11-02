---
name: Fiscal-year rollover balances
description: How annual rollover should preserve prior-year balances without double-posting.
---

- **Rule:** When creating the next fiscal year, preserve permanent-account, party, cash/bank, and stock balances through the existing posted transaction history. Do not create a second opening journal unless reporting and balance derivation are deliberately redesigned around an opening snapshot.
- **Why:** Current balances are derived from historical posted activity; inserting equivalent opening postings would count the same balances again.
- **How to apply:** Before changing year rollover, verify the balance source for each affected report/module. Keep the closed year as the source reference in the rollover audit record. Manual creation is for past/current years; future years open only through approved rollover.
