---
id: jwt-hybrid
title: "Understanding the JWT Hybrid Mode"
sidebar_label: "JWT Hybrid Mode"
description: "An explanation of Ocean Chat's JWT Hybrid strategy, balancing performance and security by separating Access Tokens and Refresh Tokens."
keywords: [ocean chat, jwt, hybrid auth, access token, refresh token, security, tokens, defense in depth, explanation]
image: "https://www.shutterstock.com/search/seo-cover"
---

<head>
  <meta name="twitter:card" content="summary_large_image" />
  <meta property="og:title" content="Understanding the JWT Hybrid Mode | Ocean Chat" />
  <meta property="og:description" content="An explanation of Ocean Chat's JWT Hybrid strategy, balancing performance and security by separating Access Tokens and Refresh Tokens." />
  <link rel="canonical" href="https://docs.oceanchat.com/devdocs/jwt-hybrid" />
</head>

# Understanding the JWT Hybrid Mode

JSON Web Tokens (JWT) are a popular standard for securely transmitting information as a JSON object. However, a single, long-lived JWT introduces profound security vulnerabilities, specifically regarding token theft and session revocation.

This document explains Ocean Chat's **JWT Hybrid Mode Authentication Strategy**. This approach achieves defense-in-depth by splitting authorization into two distinct token lifecycles: high-performance **Access Tokens** and high-security **Refresh Tokens**.

## The Context: The Single Token Vulnerability

If an application issues a single JWT valid for 30 days, the user rarely has to log in. However, if that token is intercepted via Cross-Site Scripting (XSS) or network snooping, the attacker possesses unrestricted access for a month. Revoking that specific token without stateful infrastructure is extremely difficult.

To prevent this, the lifespan of the token must be drastically shortened. But a short-lived token (e.g., 15 minutes) forces the user to re-authenticate constantly, destroying the user experience. The Hybrid Mode resolves this paradox.

## Core Concept: Separation of Authorization Concerns

The Hybrid Mode divides the authentication lifecycle into two specialized roles to address the competing needs of 99% of daily traffic versus the 1% of session renewals.

### The Access Token (AT)
The Access Token is the "boarding pass" for routine API interactions. 

- **Lifespan:** Extremely short (5 to 15 minutes).
- **Validation:** Completely stateless. Validated locally by the API Gateway using [Zero-I/O cryptography](./understanding-zero-io-authentication.md).
- **Storage Strategy:** Stored exclusively in **JavaScript memory variables** on the client. 
- **The Rationale:** Storing in memory prevents CSRF attacks (as browsers don't append it automatically) and neutralizes XSS risks (it cannot be read from `localStorage`). If a page reloads, the memory clears, minimizing the attack window to mere minutes.

### The Refresh Token (RT)
The Refresh Token is the "session key" used solely to acquire a new Access Token.

- **Lifespan:** Long-lived (7 to 30 days).
- **Validation:** Stateful. It must be checked against the database to verify it hasn't been revoked or replaced.
- **Storage Strategy:** Stored in a secure **`HttpOnly` cookie**.
- **The Rationale:** `HttpOnly` completely blocks JavaScript access, making the RT immune to XSS attacks. By binding it to a cookie, the browser automatically sends it to the `/auth/refresh` endpoint seamlessly when a new Access Token is required.

:::danger Secret Isolation
Access Tokens and Refresh Tokens MUST be signed using completely different cryptographic secrets (`JWT_ACCESS_SECRET` vs `JWT_REFRESH_SECRET`) to ensure one token cannot be derived from the other.
:::

## Alternatives and Trade-offs

When designing client-side storage, there are multiple alternatives:

- **Local Storage:** Survives reloads and tabs, providing a seamless UX. However, it is directly exposed to XSS. If an attacker injects a script, they instantly steal the long-lived credentials.
- **Session Storage:** Survives reloads within the same tab, but is still vulnerable to XSS.
- **Memory + HttpOnly Cookies (Our Approach):** The most secure approach. The primary trade-off is a slight UX hit: opening a new tab or refreshing the page clears the Access Token from memory. The client must automatically transparently call the refresh endpoint to obtain a new AT before proceeding. 

### Refresh Token Rotation

To further secure the Refresh Token, Ocean Chat employs **Token Rotation**. 

Every time the client uses an RT to get a new AT, the server issues a *brand new RT* alongside the new AT, invalidating the old RT in the database. If an attacker somehow steals an RT and attempts to use it after the legitimate user has already rotated it, the server detects a **Replay Attack**. It will immediately invalidate the entire session family, forcing the user to log in again.

## Higher-Level Perspective

The JWT Hybrid strategy is fundamentally about containment. By acknowledging that front-end environments are inherently hostile (due to browser extensions, third-party scripts, and XSS risks), the architecture minimizes the blast radius of any successful intrusion. A stolen Access Token expires before substantial damage occurs, and a highly secure, rotated Refresh Token safely manages the user's persistent trust.