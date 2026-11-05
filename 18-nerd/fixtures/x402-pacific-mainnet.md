# x402 Pacific Mainnet

A developer guide on how to get started with x402 on Pharos Pacific Mainnet

## Server-side: Using Express + x402 Middleware

For Express applications, you can use the middleware pattern:

```ts

// Load .env environment variables
import { config } from "dotenv";
config();
// Import required modules
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

// === Environment Configuration ===
const payToAddress = process.env.PAY_TO_ADDRESS as `0x${string}`;
if (!payToAddress) {
  console.error("❌ Please set the PAY_TO_ADDRESS environment variable");
  console.error('Example: export PAY_TO_ADDRESS=0xYourAddressHere');
  process.exit(1);
  }
  const facilitatorUrl = process.env.FACILITATOR_URL; // Facilitator service URL
const port = parseInt(process.env.PORT || "4021", 10); // Listening port

// USDC Configuration
const usdcAddress = process.env.USDC_ADDRESS; // USDC contract address on Pharos
const usdcName = process.env.USDC_NAME || "USDC";

// === Initialize Client and Resource Server ===
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient);

// === Create EVM Payment Scheme and Register Custom Amount Parser ===
const evmScheme = new ExactEvmScheme();
// Convert USD amount to USDC (6 decimals precision)
evmScheme.registerMoneyParser(async (amount: number, network: string) => {
  if (network === "eip155:1672") {
    return {
      amount: Math.round(amount * 1e6).toString(), // Convert to integer string (e.g., 0.01 → "10000")
      asset: usdcAddress,                          // USDC contract address
      extra: {
        token: usdcName,
        name: usdcName,
        version: "2",
      },
    };
  }
  return null;
});
// Register Pharos Pacific Mainnet (Chain ID: 1672)
resourceServer.register("eip155:1672", evmScheme);

// === Create Express App ===
const app = express();

// Use payment middleware to protect routes
app.use(
  paymentMiddleware(
    {
      // Premium endpoint: $0.01
      "GET /data": {
        accepts: {
          scheme: "exact",
          price: "0.01",
          network: "eip155:1672",
          payTo: payToAddress,
        },
        description: "Paid data endpoint",
        mimeType: "application/json",
      },
// Low-cost endpoint: $0.005
      "GET /api/info": {
        accepts: {
          scheme: "exact",
          price: "0.005",
          network: "eip155:1672",
          payTo: payToAddress,
        },
        description: "Low-cost info endpoint",
        mimeType: "application/json",
      },
    },
    resourceServer
  )
);

// === Protected Business Endpoints ===
app.get("/data", (req, res) => {
  res.json({ message: "Hello, paid user!", timestamp: Date.now() });
});
app.get("/api/info", (req, res) => {
  res.json({
    name: "Pharos x402 Server",
    network: "Pharos Pacific Mainnet",
    chainId: 1672,
    timestamp: Date.now(),
  });
});

// === Health Check (No Payment Required) ===
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
// === Start Server ===
app.listen(port, () => {
  console.log(`✅ Server started, listening on http://localhost:${port}`);
  console.log(`📡 Network: Pharos Pacific Mainnet (Chain ID: 1672)`);
  console.log(`💰 Payment receiver address: ${payToAddress}`);
  console.log(`🪙 USDC contract: ${usdcAddress}`);
});

```

## Client-side: Using Fetch + x402 SDK

```ts

// Load environment variables
import { config } from "dotenv";
config();
// Import required modules
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

// === Get EVM private key (prefer environment variable, fall back to .private_key file) ===
const privateKey = 
  process.env.EVM_PRIVATE_KEY || 
  (fs.existsSync(".private_key") ? fs.readFileSync(".private_key", "utf-8").trim() : null);
if (!privateKey) {
  console.error("❌ Please set the EVM_PRIVATE_KEY environment variable, or create a .private_key file");
  process.exit(1);
}

// === Initialize EVM account and x402 client ===
const signer = privateKeyToAccount(privateKey as `0x${string}`);
const client = new x402Client();

// Register payment scheme for Pharos Pacific Mainnet (Chain ID: 1672)
client.register("eip155:1672", new ExactEvmScheme(signer));

// Wrap fetch to enable automatic payments
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

// === Get target URL (from command-line argument, defaulting to local /data endpoint) ===
const url = process.argv[2] || "http://localhost:4021/data";
console.log(`📡 Request URL: ${url}`);
console.log(`💳 Payer account: ${signer.address}`);

// === Make a request with automatic payment ===
try {
  const response = await fetchWithPayment(url);
  const data = await response.json();
  console.log("✅ Request succeeded!");
  console.log("📦 Response data:", JSON.stringify(data, null, 2));

// If the response includes payment info, decode and print transaction details
  const paymentResponseHeader = response.headers.get("PAYMENT-RESPONSE");
  if (paymentResponseHeader) {
    const paymentResponse = decodePaymentResponseHeader(paymentResponseHeader);
    console.log("💰 Transaction hash:", paymentResponse.transaction);
    console.log("🌐 Network:", paymentResponse.network);
    console.log("📤 Payer address:", paymentResponse.payer);
  }
} catch (error) {
  console.error("❌ Request failed:", error);
  process.exit(1);
}

```

## Facilitator Implementation

```ts
import dotenv from "dotenv";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, publicActions, defineChain } from "viem";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";

dotenv.config();

// Check for EVM private key
if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ Please set EVM_PRIVATE_KEY");
  process.exit(1);
}

// Define Pharos mainnet (ID: 1672)
const pharos = defineChain({
  id: 1672,
  name: "Pharos",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.pharos.xyz"] } }, // Pharos RPC endpoint
  testnet: false,
});

// Create wallet client
const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const client = createWalletClient({
  account,
  chain: pharos,
  transport: http(undefined, { timeout: 30_000 }),
}).extend(publicActions);

// Create EVM signer required by the Facilitator
const signer = toFacilitatorEvmSigner({
  address: account.address,
  getCode: (args) => client.getCode(args),
  readContract: (args) => client.readContract({ ...args, args: args.args || [] }),
  verifyTypedData: (args) => client.verifyTypedData(args as any),
  writeContract: (args) => client.writeContract({ ...args, args: args.args || [] }),
  sendTransaction: (args) => client.sendTransaction(args),
  waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
});

// Initialize Facilitator and register Pharos chain
const facilitator = new x402Facilitator();
facilitator.register("eip155:1672", new ExactEvmScheme(signer, { deployERC4337WithEIP6492: true }));

// Create Express app
const app = express();
app.use(express.json());

// Verify payment
app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    const result = await facilitator.verify(paymentPayload, paymentRequirements);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Settle payment on-chain
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Return supported payment schemes
app.get("/supported", (req, res) => {
  res.json(facilitator.getSupported());
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Facilitator is running on port: ${PORT}`);
  console.log(`⛓️ Supported network: eip155:1672 (Pharos Pacific)`);
});

```

## Skill

**Skill Repository:** `https://github.com/PharosNetwork/examples/tree/main/skills/x402-pharos`

This skill facilitates using the x402 SDK to construct the Pharos x402 server and the corresponding test client. This skill targets the Pharos Pacific Mainnet with chain ID 1672. Configure the USDC token address (`0xc879c018db60520f4355c26ed1a6d572cdac1815`) with the official token contract address you intend to use for payments.

The following demonstrates building a server and client demo using this skill, taking opencode as an example.

**Create Server:** Enter the prompt: "Help me create a pharos-x402 server." It will ask for corresponding parameters (recipient address, Facilitator URL, etc.) and automatically generate the corresponding code files and configuration files.

<figure><img src="https://3298017099-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FNmFp0ycownpuaUNf2xeE%2Fuploads%2Fgit-blob-18768f55bc11344c54eecfe6ba65a61352b8300b%2Fx402-2.png?alt=media" alt="x402-2"><figcaption></figcaption></figure>

During the process, you can ask it to generate simple example code through conversation, including `/data` and `/premium` endpoints.

<figure><img src="https://3298017099-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FNmFp0ycownpuaUNf2xeE%2Fuploads%2Fgit-blob-316bb7964b7d848dd08f0ec19ec2ef0be991ccee%2Fx402-3.png?alt=media" alt="x402-3"><figcaption></figcaption></figure>

The service can then be started.

<figure><img src="https://3298017099-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FNmFp0ycownpuaUNf2xeE%2Fuploads%2Fgit-blob-23fa3541b42f20bb629b881c02251ae8d250c076%2Fx402-4.png?alt=media" alt="x402-4"><figcaption></figcaption></figure>

Next, you can ask it to write a test client.

<figure><img src="https://3298017099-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FNmFp0ycownpuaUNf2xeE%2Fuploads%2Fgit-blob-73535c7cd1afe9b9ae753ed886f82f1e4e1baeb6%2Fx402-5.png?alt=media" alt="x402-5"><figcaption></figcaption></figure>

Once the private key is configured, you can test the payment process.

**Please note: never reveal your private key to large models. Configure it via environment variables or file writing.**

<figure><img src="https://3298017099-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FNmFp0ycownpuaUNf2xeE%2Fuploads%2Fgit-blob-43d4fce647717e3b77227f533a45447155d31d63%2Fx402-6.png?alt=media" alt="x402-6"><figcaption></figcaption></figure>

## Advantages of x402 on Pharos

| Features                | Pharos         | Other EVM Chains        |
| ----------------------- | -------------- | ----------------------- |
| TPS                     | 30,000         | Usually < 5,000         |
| Block Time              | < 1 Second     | Usually 2 - 15 Seconds  |
| Finality Time           | Sub-second     | Usually several minutes |
| Micro-payment Viability | Extremely High | Low - High              |

### Why Choose Pharos for x402?

* **Ultra-low transaction costs:** Pharos's high throughput and efficient consensus minimize transaction costs, making micro-payments truly economically viable.
* **Instant Finality:** Sub-second finality means users can access content immediately after payment without waiting for multiple block confirmations.
* **EVM Compatibility:** Fully compatible with Ethereum tools (ethers.js, viem, Hardhat, etc.); existing developers do not need to learn new tools.
* **Compliance-Friendly:** Pharos's built-in compliance modules (ZK-KYC/AML) allow x402 payments to meet regulatory requirements, making it suitable for institutional adoption.
* **Modular Architecture:** Through SPN (Specialized Processing Network), the execution environment can be customized for specific payment scenarios.

## Development Recommendations

* **Temporary Access Authorization based on JWT:** After the user completes payment verification, the server can issue a short-term valid JSON Web Token (JWT) as a credential for subsequent resource access. This token should have a reasonable expiration time to avoid repeated payments while reducing the overhead of frequent on-chain verification by the server.
* **Security Management of Sensitive Information:** All confidential data such as private keys and API keys should be injected into the application through environment variables or dedicated secret management services. Hardcoding them in source code or configuration files is strictly prohibited to prevent accidental leakage.
* **Transaction Idempotency and Retry Support:** The client should be able to initiate a retry request based on the original transaction hash after a network interruption or request failure. The server must implement idempotency processing logic to ensure that the same on-chain transaction is not billed multiple times or granted permissions repeatedly.
* **Introducing Facilitator Service to Decouple Blockchain Interaction:** Design a middleware service (Facilitator) to encapsulate complex logic such as blockchain node communication, transaction listening, and verification, simplifying the main business code. However, note that this component could become a performance bottleneck or a single point of failure; it is recommended to combine redundant deployment, health checks, multi-account strategies, and downgrade policies to improve system resilience.

## Reference Resources

* **Pharos Official Website:** `https://www.pharos.xyz/`
* **Pharos Documentation:** `https://docs.pharos.xyz/`
* **x402 Specification:** `https://x402.org/`
