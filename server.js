var express = require("express");
var Anthropic = require("@anthropic-ai/sdk").default;
var path = require("path");
var fs = require("fs");

var app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

var client = new Anthropic();

// Read prompt and corpus from files (no template literals needed)
var SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.txt"), "utf8");
var CORPUS = fs.readFileSync(path.join(__dirname, "corpus.txt"), "utf8");

var MODELS = [
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001"
];
var MAX_RETRIES = 3;
var RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function isOverloaded(err) {
  var msg = String(err && err.message || "") + String(err && err.cause && err.cause.message || "");
  return msg.indexOf("Overloaded") !== -1 || msg.indexOf("overloaded") !== -1 || (err && err.status === 529);
}

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

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Darenard ecoute sur le port " + PORT);
});
