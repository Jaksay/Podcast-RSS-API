const { Router } = require("express");
const podcastRouter = require("./podcast");

const router = Router();

router.use("/podcast", podcastRouter);

module.exports = router;
