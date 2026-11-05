import json, urllib.request

BASE = "http://localhost:4747"

# Step 1: Create a new novel
data = json.dumps({"title": "Test Character Novel", "genre": "Fantasy"}).encode()
req = urllib.request.Request(BASE + "/api/novels", data=data, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=10) as r:
    novel = json.load(r)
print("Novel created:", novel["id"], novel["title"])

# Step 2: Add a chapter with character content
chapter_body = """Aria entered the great hall. She saw Captain Varn. The captain wore a red cloak and carried a silver dagger. Behind him stood Finn, a young apprentice with a nervous disposition. Aria noticed the suspicious mark on Varn's neck."""
data = json.dumps({"title": "Chapter 1", "body": chapter_body}).encode()
req = urllib.request.Request(BASE + "/api/novels/" + str(novel["id"]) + "/chapters", data=data, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=10) as r:
    chapter = json.load(r)
print("Chapter created:", chapter["id"], chapter["title"])

# Step 3: Run character analysis via the AI route
data = json.dumps({"chapterId": chapter["id"]}).encode()
req = urllib.request.Request(BASE + "/api/ai/analyze-chapter", data=data, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=120) as r:
    result = json.load(r)
print("Analysis summary:", result.get("summary", "(none)")[:120])
print("Suggestions count:", len(result.get("suggestions", [])))

# Step 4: Check characters in database via the characters API
req = urllib.request.Request(BASE + "/api/novels/" + str(novel["id"]) + "/characters", headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=10) as r:
    chars = json.load(r)
print("\nCharacters in DB:", json.dumps(chars, indent=2)[:600])

# Step 5: Check pending suggestions
req = urllib.request.Request(BASE + "/api/novels/" + str(novel["id"]) + "/characters/pending", headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=10) as r:
    suggs = json.load(r)
print("\nPending suggestions:", json.dumps(suggs, indent=2)[:600])

# Step 6: Check character graph
req = urllib.request.Request(BASE + "/api/novels/" + str(novel["id"]) + "/characters/graph", headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=10) as r:
    graph = json.load(r)
print("\nCharacter graph nodes:", len(graph.get("nodes", [])), "links:", len(graph.get("links", [])))