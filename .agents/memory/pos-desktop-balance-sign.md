---
name: POS Desktop balance sign convention
description: Desktop accounts_local.balance is TYPE-ADJUSTED, not raw debit-credit; any DR/CR pill or report must convert before aggregating.
---

Desktop (`accounts_local.balance` in SQLite) stores a **type-adjusted** running
balance via `signed_delta`: for `asset`/`expense` it is `debit - credit`, for
`liability`/`equity`/`revenue` it is `credit - debit`. So a healthy account is
always naturally **positive** regardless of its normal side.

The web app instead stores/shows a **raw** `debit - credit` signed balance and
decides DR/CR by sign.

**Rule:** to render a web-style DR/CR pill or aggregate balances across
descendants on desktop, convert each account back to raw first:
`rawBal = (type === 'asset' || type === 'expense') ? balance : -balance`,
sum `rawBal` over the subtree, then `isCredit = sum < 0`.

**Why:** mixing the two conventions silently flips the sign on liability/equity/
revenue accounts, so a credit-normal account would display as a debit balance.

**How to apply:** any new desktop COA pill, trial-balance-like roll-up, or report
that wants raw signed semantics must do this per-account conversion before
summing. Chart of Accounts (`ChartOfAccounts.tsx`) already does this.
