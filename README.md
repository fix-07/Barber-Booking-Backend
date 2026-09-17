# VEYRON Backend

Node.js/Express REST API for the VEYRON barber booking platform. Handles auth, bookings, barbers, admin management, reviews, and notifications, backed by MongoDB.

## Tech stack

- Node.js + Express 5
- MongoDB + Mongoose
- JWT auth (jsonwebtoken) with bcrypt password hashing
- express-validator for request validation
- Nodemailer / Resend for transactional email
- Google Auth Library for Google Sign-In
- Jest + Supertest for tests

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in real values (MongoDB URI, JWT secret, mail provider, etc.):

```bash
cp .env.example .env
```

## Run

```bash
npm run dev     # nodemon, auto-restarts on changes
npm start       # plain node
npm test        # Jest test suite
```

The server listens on the port set by `PORT` in `.env` (defaults to 5000; the original project's `.env` sets 5050).

## Project layout

```
config/       database connection
controllers/  route handlers
middleware/   auth, validation, rate limiting, security headers, etc.
models/       Mongoose schemas
routes/       Express routers
scripts/      one-off/admin CLI scripts (e.g. createAdmin.js)
services/     notification/email service logic
tests/        Jest integration tests
utils/        shared helpers (token signing, mailer, audit log, etc.)
server.js     app entry point
```

## Note

This folder is a copy of the `server/` directory from the original `barber-booking-platform` project, made for backup/separation purposes. `node_modules` was excluded from the copy — run `npm install` before starting the server.
