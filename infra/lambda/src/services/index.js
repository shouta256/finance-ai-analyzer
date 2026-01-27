"use strict";

// Services barrel export
module.exports = {
  ...require("./auth"),
  ...require("./plaid"),
  ...require("./ai"),
  ...require("./demo"),
  ...require("./analytics"),
  ...require("./transactions"),
};
