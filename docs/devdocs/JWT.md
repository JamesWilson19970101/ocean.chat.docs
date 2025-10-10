# JWT Hybrid Authentication

In modern web applications and microservices architectures, authentication is the cornerstone of the security system. JWT (JSON Web Token) based authentication is widely adopted due to its stateless, scalable, and cross-domain-friendly features. However, a single, long-lived JWT token has inherent risks in terms of security and flexibility.

:::tip Core Idea
This platform adopts a **JWT Hybrid Mode Authentication Strategy**. This strategy combines the use of a short-lived `Access Token` and a long-lived `Refresh Token`, implementing defense-in-depth at every stage to achieve the best balance between high performance, high security, and excellent user experience.
:::

## Access Token (AT)

- **Role**: The "pass" for clients to access protected resources. It is a high-frequency use token.

- **Characteristics**:

  - **Short-lived**: The validity period is extremely short, planned to be **5 to 15 minutes**.
  - **Stateless Validation**: The server only needs to verify its signature and expiration to trust its content, without querying the database. This ensures extremely high processing performance.
  - **Risk**: Due to its high frequency of use and transmission, the risk of theft is relatively high. Its short lifespan is key to mitigating this risk.

- **Payload**: Contains non-sensitive user identity information, such as user ID, roles, etc., following the principle of least privilege.

## Refresh Token (RT)

- **Role**: The sole credential for obtaining a new Access Token. It can be seen as the "session key" that maintains the user's login state. It is a low-frequency use token.

- **Characteristics**:
  - **Long-lived**: The validity period is longer, planned to be **7 to 30 days**.
  - **Stateful Validation**: When processing an RT, the server must query the database or cache to verify if it is still valid. This provides the ability to revoke sessions.
  - **Risk**: Once leaked, it can lead to severe security consequences. Therefore, it must be protected with the strictest storage and transmission measures.

## Hybrid Mode

The core idea of this mode is to separate authentication responsibilities:

- **Daily Access (99% of scenarios)**: Use stateless, high-performance Access Tokens.

- **Session Renewal (1% of scenarios)**: Use stateful, high-security Refresh Tokens.

This design allows the system to respond quickly in most cases while retaining the ability to perform strict security checks at critical moments (like session refresh, logout).

## Security Strategy

### Secure Token Generation & Configuration

:::danger Isolate Secrets
The Access Token and Refresh Token **must** be signed with two completely different and sufficiently complex secrets (`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`) to prevent one from being inferred from the other.
:::

**Minimize Payload**: The Access Token payload **must not** contain any sensitive information (such as passwords, phone numbers, detailed permissions, etc.). It should only contain necessary identifiers (like `userId`) and roles.

**Reasonable Expiration**:

- AT: `15m` (15 minutes).
- RT: `7d` (7 days).

### Secure Client-Side Storage

#### Access Token

**Preferred: Store in JavaScript memory variables**. This is the most secure method as it does not persist between browser sessions and is completely immune to CSRF attacks.

:::tip Advantages

- **Extremely High Security**: This is the best way to defend against XSS (Cross-Site Scripting) attacks. Because the token is stored in a JavaScript variable, even if an attacker can inject a script, they cannot directly and persistently read it like they could with `sessionStorage` or `localStorage`.
- **No CSRF Risk**: Since the token needs to be manually added to the `Authorization` request header via JavaScript, the browser does not automatically include it, making it completely immune to CSRF (Cross-Site Request Forgery) attacks.
- **Minimal Attack Window**: Once the user closes the tab or refreshes the page, the memory variable is cleared, and the token disappears immediately. This means even if the token is stolen at some point, its lifespan is extremely short.
  :::

:::caution Disadvantages

- **Poor User Experience**: This is the biggest drawback. Every time a user refreshes the page or opens a new tab to access your application, the Access Token in memory is lost. This forces the application to immediately use the Refresh Token to get a new Access Token, increasing the frequency of requests to the `/refresh` endpoint. If the network is poor, the user may feel a noticeable "reload" or "lag".
  :::

**Secondary: Store in `sessionStorage`**. It persists on page refresh but is cleared when the browser window is closed.

:::tip Advantages

- **Better User Experience**: It can persist within a single tab's session. After a user refreshes the page, the token is still valid, and the application can immediately restore its state without needing to request a new token.
- **Isolation**: `sessionStorage` is tab-based. The data is cleared when the tab is closed and is not stored permanently like `localStorage`.
  :::

:::caution Disadvantages

- **Vulnerable to XSS**: This is its biggest security vulnerability compared to in-memory storage. If your site has an XSS vulnerability, an attacker's injected script can easily read the token via `sessionStorage.getItem('accessToken')` and send it to their own server.
  :::

#### Refresh Token

**Store in an `HttpOnly` browser Cookie.**

:::info Cookie Attributes

- `HttpOnly`: This flag prevents any client-side JavaScript from accessing the cookie, fundamentally stopping XSS attacks from stealing the RT.
- `Secure`: This flag forces the browser to only send the cookie over HTTPS connections.
- `SameSite=Strict` or `Lax`: This flag helps defend against CSRF (Cross-Site Request Forgery) attacks.
  :::

### Secure Token Transmission

**Enforce HTTPS**: All authentication-related endpoints, and the entire application, **must** be forced to use HTTPS (TLS) encryption. This prevents tokens from being intercepted by Man-in-the-Middle (MITM) attacks during transmission.

### Secure Token Rotation & Validation

**Refresh Token Rotation**: This is the core mechanism for detecting RT theft.

1.  When a client uses an RT (`RT_A`) to refresh, the server, upon successful validation, returns both a new AT (`AT_B`) and a brand new RT (`RT_B`).
2.  The server immediately marks the old `RT_A` as used or invalid.

:::danger Replay Attack Detected
If the server later receives another refresh request with `RT_A`, it means the token may have been stolen (an attacker is replaying the old token). In this case, the server should immediately invalidate all sessions for that user, forcing them to re-login on all devices.
:::

### Secure Session Termination

**User Logout**: When a user logs out, the client should actively request the `/logout` endpoint. Upon receiving the request, the server must clear the corresponding RT hash stored in the database, thus invalidating the RT immediately.

**Force Logout from All Devices**: Provide a "Security Settings" option that allows the user to clear all RT records associated with their account, achieving a one-click sign-out.

## Workflow

#### Step 1: Initial Login

**Client**: User enters username and password on the login page and clicks login.

**Server**:

1.  Validate the credentials.
2.  If correct, generate a pair of tokens:
    - A short-lived Access Token (`AT_A`).
    - A long-lived Refresh Token (`RT_A`).
3.  Hash `RT_A` and store the hash (`Hashed_RT_A`) in the corresponding user record in the database.
4.  Send the tokens back to the client via HTTP response:
    - `AT_A` is placed in the response body (JSON Body).
    - `RT_A` is placed in a `Set-Cookie` response header with the `HttpOnly; Secure; SameSite=Strict` flags.

#### Step 2: Accessing Protected Resources

**Client**:

1.  Stores `AT_A` from the response body in memory.
2.  Includes `AT_A` in the `Authorization: Bearer <AT_A>` header for every request to a protected API.

**Server**:

1.  Receives the request and extracts `AT_A`.
2.  Performs a quick, stateless validation (checks signature and expiration).
3.  If valid, processes the request and returns data.

#### Step 3: Access Token Expiration & Refresh

**Client**: Makes an API request with an expired `AT_A`.

**Server**: Validates `AT_A`, finds it has expired, rejects the request, and returns a `401 Unauthorized` status code.

**Client (Request Interceptor)**:

1.  Automatically catches the `401` error.
2.  Automatically sends a request to the server's `/auth/refresh` endpoint(server response should include path). The browser will automatically include the `RT_A` stored in the `HttpOnly` cookie.

**Server (`/auth/refresh` endpoint)**:

1.  Gets `RT_A` from the cookie.
2.  Performs **stateful validation**:
    - Checks the signature and expiration of `RT_A`.
    - Extracts `userId` from the `RT_A` payload.
    - Queries the database using `userId` to get the stored `Hashed_RT_A`.
    - Compares the hash of the received `RT_A` with `Hashed_RT_A`.
3.  **Validation Succeeded (Token Rotation)**:
    - Generate a brand new pair of tokens: `AT_B` and `RT_B`.
    - Hash `RT_B` and use the new `Hashed_RT_B` to overwrite `Hashed_RT_A` in the database.
    - Return `AT_B` and the new `RT_B` (via `HttpOnly` cookie) to the client.
4.  **Validation Failed**: Return `403 Forbidden`, indicating an invalid session.

**Client (Request Interceptor)**:

1.  Upon receiving the new `AT_B`, updates the Access Token in memory.
2.  Automatically retries the API request that just failed with a `401`.
3.  If a `403` is received, clears all local state and redirects the user to the login page.

#### Step 4: Logout

**Client**: User clicks the logout button, sending a request to the `/auth/logout` endpoint.

**Server**:

1.  Identifies the user via the Access Token.
2.  Finds the user's record in the database and sets their `hashedRefreshToken` field to `null`.
3.  Sends a `Set-Cookie` header in the response to clear the `HttpOnly` cookie.
