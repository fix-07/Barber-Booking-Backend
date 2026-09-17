/**
 * Checks the environment variables at startup and refuses to run if
 * something essential is missing or unsafe.
 *
 * WHY FAIL INSTEAD OF WARN:
 * A server that starts with a weak or missing JWT_SECRET looks fine and
 * quietly issues forgeable login tokens. Failing loudly on your machine,
 * before any user exists, is far cheaper than discovering it later.
 */
const MINIMUM_SECRET_LENGTH = 32;

const validateEnv = () => {
  const problems = [];

  if (!process.env.MONGO_URI) {
    problems.push("MONGO_URI is missing. Add it to server/.env");
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    problems.push("JWT_SECRET is missing. Add it to server/.env");
  } else if (secret.length < MINIMUM_SECRET_LENGTH) {
    problems.push(
      `JWT_SECRET is too short (${secret.length} characters). ` +
        `Use at least ${MINIMUM_SECRET_LENGTH}. Generate one with:\n` +
        `    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
    );
  }

  if (problems.length > 0) {
    console.error("\nServer cannot start. Fix these first:\n");
    problems.forEach((problem, index) =>
      console.error(`  ${index + 1}. ${problem}`)
    );
    console.error("");
    process.exit(1);
  }
};

module.exports = validateEnv;
