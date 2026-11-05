import json, urllib.request

req = urllib.request.Request(
    "http://localhost:11434/api/chat",
    data=json.dumps({
        "model": "qwen3:4b",
        "messages": [{"role": "user", "content": "Write one sentence of prose about a lighthouse."}],
        "stream": False,
        "think": False,
        "options": {"num_predict": 400, "temperature": 0.7},
    }).encode(),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=120) as r:
    d = json.load(r)
c = d["message"]["content"]
print("HAS <think> TAG:", "<think>" in c or "</think>" in c)
print("FULL OUTPUT:")
print("-" * 60)
print(c)
