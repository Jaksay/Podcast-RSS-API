const path = require("path");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { apiRoutes } = require("./routes");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

const requireApiKey = (req, res, next) => {
  if (!API_KEY) {
    res.status(500).json({ error: "API_KEY 未配置，请联系管理员" });
    return;
  }

  const providedKey = req.header("x-api-key") || req.query.api_key;
  if (providedKey !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", requireApiKey, apiRoutes);

app.listen(PORT, () => {
  console.log(`Express server listening at http://localhost:${PORT}`);
});
