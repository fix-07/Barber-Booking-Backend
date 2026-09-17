/**
 * notFound: runs when no route matched the URL.
 * Without this, Express 5 sends an HTML error page, which is odd for an API.
 */
const notFound = (req, res) => {
  res.status(404).json({ message: "This API endpoint does not exist." });
};

/**
 * errorHandler: the single place where unexpected errors are turned into a
 * response. Express knows this is the error handler because it takes FOUR
 * arguments. It must be registered last, after all routes.
 *
 * WHY THIS MATTERS FOR SECURITY:
 * Your original code replied with  error.message  to the client. Internal
 * error text can reveal field names, file paths, driver details, and
 * sometimes even parts of a connection string. We log the full error to the
 * server terminal (where only you can see it) and send the client a plain,
 * unhelpful-to-an-attacker message.
 */
const errorHandler = (error, req, res, next) => {
  // Log for the developer. Never log req.body here: it can contain passwords.
  console.error(`[error] ${req.method} ${req.originalUrl}`, error);

  // --- Known, safe-to-explain errors -------------------------------

  // Mongoose schema validation failed. Telling the user which field is
  // wrong is helpful and not sensitive.
  if (error.name === "ValidationError") {
    const errors = {};
    for (const [field, detail] of Object.entries(error.errors || {})) {
      errors[field] = detail.message;
    }
    return res.status(400).json({
      message: "Please correct the highlighted fields.",
      errors,
    });
  }

  // A malformed id was passed where an ObjectId was expected.
  if (error.name === "CastError") {
    return res.status(400).json({ message: "Invalid id provided." });
  }

  // Duplicate key: code 11000 comes from a unique index, such as email.
  if (error.code === 11000) {
    return res
      .status(409)
      .json({ message: "That value is already in use." });
  }

  // Body was not valid JSON (thrown by express.json()).
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Request body is not valid JSON." });
  }

  // Body was larger than our limit.
  if (error.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body is too large." });
  }

  // --- Everything else: say as little as possible ------------------
  const status = error.statusCode || error.status || 500;
  res.status(status).json({
    message:
      status === 500
        ? "Something went wrong on our side. Please try again."
        : error.message || "Request could not be completed.",
  });
};

module.exports = { notFound, errorHandler };
