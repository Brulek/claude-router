结论：rotate_b.sh 的出错处理更健壮。

理由：
1. rotate_b 校验参数个数和 KEEP_DAYS 是否为数字，错误时返回明确退出码（64、66、73、74）。rotate_a 只检查参数是否存在。
2. rotate_b 在 gzip 失败时删除半成品归档并保留原日志，然后退出。
3. rotate_b 逐个删除旧归档，单个 rm 失败只报错、不中断。rotate_a 的 `((removed++))` 在 removed 为 0 时返回非零，set -e 下脚本会在第一次删除后直接退出，不打印结果。
4. rotate_b 用 `while read` 处理文件名，含空格的归档不会被拆开。rotate_a 用 `$(find ...)` 循环，会按空白拆分。

未修改任何文件。