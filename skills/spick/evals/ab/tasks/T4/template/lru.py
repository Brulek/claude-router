class LRU:
    def __init__(self, cap):
        self.cap = cap
        self.d = {}
        self.order = []

    def get(self, k):
        if k not in self.d:
            return None
        self.order.remove(k)
        self.order.append(k)
        return self.d[k]

    def put(self, k, v):
        if k in self.d:
            self.d[k] = v
            return
        if len(self.d) >= self.cap:
            old = self.order.pop(0)
            del self.d[old]
        self.d[k] = v
        self.order.append(k)
