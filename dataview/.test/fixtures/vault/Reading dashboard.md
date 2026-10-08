---
goal: 12
---
# Reading

```dataview
TABLE author AS "Author", rating, status
FROM #book
SORT rating DESC
```

Finished this year: `= length(filter([[Dune]].file.tags, (t) => t = "#book"))`
