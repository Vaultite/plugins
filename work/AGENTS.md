## Work (`Work.md`, and logs in area `work`)
Work log entries (area `work`, the user's job) are only the user's own short notes: `kind: conversation |
investigation | build | video | idea`, optional `person`, `topic`, `link`, `status` for ideas (idea | planned | doing |
done | dropped). No company credentials, code, documents, client names or client data.

The focus card on the Work page is `Work.md` (`PUT /api/work`):
```
---
type: work
focus: Shipping the new onboarding
questions: ['What should the first week look like?']
colleagues:
- {name: Alex Kim, role: Designer}
---
```
Its blocks are on the Work page.
