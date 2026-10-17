def format_item(item):
    return f"{item.name}: {item.qty} x {item.price:.2f}"


def format_report(store):
    lines = [format_item(i) for i in store.all_items()]
    lines.append(f"total: {store.total_value():.2f}")
    return "\n".join(lines)
