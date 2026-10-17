# samples/

The shape of an out dir (`<arm>/<task>/run-<n>/{work,result.json}`, `_arms/`, `grades.json`, `REPORT-<date>.md`) for one cell: `haiku-bare` on T2.

This one was produced with a stub in place of `claude` (`--claude-bin`), because the session that built the harness could not authenticate `claude -p` (OAuth refresh failed inside its sandbox). No model ran: the answer reads "STUB", the cost is zero, and the cell fails on purpose. Replace it with a real run:

    python3 run.py --arms haiku-bare --tasks T2 --runs 1 --out samples/ --force
    python3 grade.py samples/ && python3 report.py samples/
