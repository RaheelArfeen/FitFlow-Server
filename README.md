# FitFlow Backend API

**Base URL:** [https://fitflow-server-red.vercel.app/](https://fitflow-server-red.vercel.app/)

This repository contains the backend API for the FitFlow fitness web application. Built with Node.js, Express, and MongoDB, it provides secure RESTful endpoints to support user authentication, trainer management, class scheduling, booking, payments, and community features.

---

## Features

- User authentication and role management via Firebase
- Trainer application processing and approval workflow
- Management of trainer availability and booking slots
- Class creation, listing, and registration
- Payment processing integration with Stripe
- Community forum support with voting and posts
- Newsletter subscription handling
- Secure role-based access control for Admin, Trainer, and Member

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB Atlas
- **Authentication:** Firebase Admin SDK
- **Payments:** Stripe API
- **Deployment:** Vercel

---

## Getting Started

### Prerequisites

- Node.js and npm installed
- MongoDB Atlas cluster
- Firebase project with service account credentials
- Stripe account and API keys

---

## Environment Variables

Set the following environment variables in your `.env` file:

- `DB_USER` — Your database username
- `DB_PASS` — Your database password
- `JWT_ACCESS_SECRET` — Secret key for JWT authentication
- `NODE_ENV` — Environment mode (e.g., development, production)
- `STRIPE_SECRET_KEY` — Your Stripe secret API key
- `FB_SERVICE_KEY` — Firebase service account key or JSON string

---

## API Endpoints Overview

The backend exposes RESTful endpoints to handle:

- **Authentication:** User registration, login, role verification
- **Trainers:** Application submission, approval, slot management
- **Classes:** Creation, listing, user registration
- **Bookings:** Session booking, cancellations, payment processing
- **Community:** Posts creation, voting, comments
- **Newsletter:** Subscription management

For detailed API documentation and request/response schemas, please refer to the project’s API documentation (or add links here if available).

---

## Deployment

This backend is deployed on Vercel at [https://fitflow-server-red.vercel.app/](https://fitflow-server-red.vercel.app/). Ensure environment variables are configured in the Vercel dashboard for production.

---

## License

This backend API is open source and free to use for personal or commercial purposes. Attribution is appreciated but not required.
