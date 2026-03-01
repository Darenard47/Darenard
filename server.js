var express = require("express");
var Anthropic = require("@anthropic-ai/sdk").default;
var path = require("path");
var fs = require("fs");

var app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

var client = new Anthropic();

var SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.txt"), "utf8");
var CORPUS = fs.readFileSync(path.join(__dirname, "corpus.txt"), "utf8");

var MODELS = [
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001"
];
var MAX_RETRIES = 3;
var RETRY_DELAY_MS = 3000;

// ══════════════════════════════════════════════════
// UPSTASH REDIS — stockage persistant gratuit
// Variables d'environnement requises :
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
// ══════════════════════════════════════════════════

var REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
var REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    var res = await fetch(REDIS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + REDIS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(["GET", key])
    });
    var data = await res.json();
    if (data.result) return JSON.parse(data.result);
    return null;
  } catch (e) {
    console.error("[Redis GET] " + key + ": " + e.message);
    return null;
  }
}

async function redisSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  try {
    var res = await fetch(REDIS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + REDIS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(["SET", key, JSON.stringify(value)])
    });
    var data = await res.json();
    return data.result === "OK";
  } catch (e) {
    console.error("[Redis SET] " + key + ": " + e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function isOverloaded(err) {
  var msg = String(err && err.message || "") + String(err && err.cause && err.cause.message || "");
  return msg.indexOf("Overloaded") !== -1 || msg.indexOf("overloaded") !== -1 || (err && err.status === 529);
}

// ══════════════════════════════════════════════════
// CHAT API
// ══════════════════════════════════════════════════

app.post("/api/chat", async function(req, res) {
  try {
    var messages = req.body.messages;

    var corpusMessage = CORPUS + "\n\n---\n\nBonjour Darenard.";

    var fullMessages = [
      { role: "user", content: corpusMessage },
      { role: "assistant", content: "Je note que mon corpus est charge. J attends la premiere interaction pour delivrer le Tour 1." }
    ].concat(messages);

    var result = null;
    var lastError = null;

    for (var m = 0; m < MODELS.length; m++) {
      var model = MODELS[m];
      for (var attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          console.log("[Darenard] " + model + " attempt " + attempt + "/" + MAX_RETRIES);
          result = await client.messages.create({
            model: model,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: fullMessages
          });
          lastError = null;
          console.log("[Darenard] Success with " + model);
          break;
        } catch (err) {
          lastError = err;
          console.error("[Darenard] " + model + " attempt " + attempt + " failed: " + (err.message || err));
          if (!isOverloaded(err)) break;
          if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
        }
      }
      if (result && !lastError) break;
    }

    if (!result || lastError) {
      throw lastError || new Error("All models failed");
    }

    var text = "";
    for (var i = 0; i < result.content.length; i++) {
      if (result.content[i].type === "text") {
        text += result.content[i].text;
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    var words = text.split(/(\s+)/);
    for (var w = 0; w < words.length; w += 3) {
      var chunk = words.slice(w, w + 3).join("");
      res.write("data: " + JSON.stringify({ text: chunk }) + "\n\n");
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("[Darenard] Final error: " + (error.message || error));
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.write("data: " + JSON.stringify({ text: "Mon ecriture m echappe... les serveurs sont surcharges. Reessayez dans quelques minutes." }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
});

// ══════════════════════════════════════════════════
// ABSENCE COUNTER
// Clé Redis : "darenard:absence"
// Valeur : { timestamp: "2026-03-01T..." }
// ══════════════════════════════════════════════════

app.get("/api/absence", async function(req, res) {
  var data = await redisGet("darenard:absence");
  if (!data) {
    data = { timestamp: new Date().toISOString() };
    await redisSet("darenard:absence", data);
  }
  res.json(data);
});

// POST /api/absence/reset — remet le compteur à zéro
// curl -X POST https://darenard.onrender.com/api/absence/reset \
//   -H "Content-Type: application/json" -d '{"key":"VOTRE_CLE"}'
app.post("/api/absence/reset", async function(req, res) {
  var adminKey = process.env.ADMIN_KEY || "darenard-admin";
  if (req.body.key !== adminKey) {
    return res.status(403).json({ error: "unauthorized" });
  }
  var data = { timestamp: new Date().toISOString() };
  await redisSet("darenard:absence", data);
  res.json({ ok: true, timestamp: data.timestamp });
});

// ══════════════════════════════════════════════════
// SECOND STYLE — archive des non-amis
// Clé Redis : "darenard:styles"
// Valeur : { entries: [...] }
// ══════════════════════════════════════════════════

app.get("/api/styles", async function(req, res) {
  var data = await redisGet("darenard:styles");
  if (!data) data = { entries: [] };
  var entries = (data.entries || []).map(function(e) {
    return {
      pseudo: e.pseudo,
      date: e.date,
      text: (e.text || "").substring(0, 80)
    };
  });
  res.json({ count: entries.length, entries: entries });
});

app.post("/api/styles", async function(req, res) {
  try {
    var pseudo = req.body.pseudo;
    var text = req.body.text;

    console.log("[Styles] POST received — pseudo: " + pseudo + ", text length: " + (text ? text.length : 0));

    if (!text || text.length < 20) {
      console.log("[Styles] Rejected: text too short");
      return res.status(400).json({ error: "text too short" });
    }
    if (text.length > 50000) {
      return res.status(400).json({ error: "text too long" });
    }

    var data = await redisGet("darenard:styles");
    if (!data) data = { entries: [] };
    console.log("[Styles] Current entries: " + data.entries.length);

    data.entries.push({
      pseudo: (pseudo || "Second style").substring(0, 60),
      text: text.substring(0, 50000),
      date: new Date().toISOString()
    });

    var saved = await redisSet("darenard:styles", data);
    console.log("[Styles] Redis SET result: " + saved);

    res.json({ ok: true });
  } catch (e) {
    console.error("[Styles] Error:", e.message || e);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/styles/:index", async function(req, res) {
  var data = await redisGet("darenard:styles");
  if (!data) data = { entries: [] };
  var idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= data.entries.length) {
    return res.status(404).json({ error: "not found" });
  }
  var entry = data.entries[idx];
  res.json({ pseudo: entry.pseudo, text: entry.text, date: entry.date });
});

// ══════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Darenard ecoute sur le port " + PORT);
  if (!REDIS_URL) {
    console.warn("[WARN] UPSTASH_REDIS_REST_URL non defini — le stockage ne persistera pas entre les redeplois.");
  }
});
