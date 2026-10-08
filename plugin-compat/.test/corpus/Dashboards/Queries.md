# Queries

```dataview
TABLE status, due FROM #project
```

```dataview
LIST FROM "Daily" SORT file.name DESC
```

```tasks
not done
sort by due
```

```dataviewjs
dv.paragraph("Pages: " + dv.pages().length)
```

Inline: `= this.file.name`
