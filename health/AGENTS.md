## Health
Areas `workouts`, `sleep`, `nutrition` (parent `health`); a vault may have its own workout areas (`running`), each drawn
with ```` ```block-workouts ```` and `area:`. A workout log has `kind` (Strength, Run, Climb...), optional `place`, and
`exercises` (sets) or `climbs` (`[{grade, note}]`, or just `top_grade`). A meal is one nutrition log: `meal: Lunch`,
`kcal`, `protein`, `carbs`, `fat` (estimates from a photo are fine). A workout log has a ```` ```block-workout ````
fence under its ```` ```block-log ````.

A day's activity is a log in `health` (Apple Health writes them: `steps`, `active_kcal`, `exercise_min`, `resting_hr`,
`hrv_ms`, `vo2max`, `weight_kg`), drawn by ```` ```block-activity ````; a night may have `deep_min`, `core_min`, `rem_min`,
`awake_min`.

No files of its own: it draws the workout, sleep, activity and nutrition logs (the Health page).
