# Circle CCTP

## Overview

Circle’s Cross-Chain Transfer Protocol (CCTP) enables secure transfer of USDC across blockchains using a native burn-and-mint mechanism.

On Pharos, CCTP allows developers to move USDC between supported networks without relying on traditional bridges or wrapped tokens.

Unlike lock-and-mint bridges, CCTP burns USDC on the source chain and mints native USDC on the destination chain, ensuring a 1:1 transfer with no liquidity fragmentation.

## Contract Addresses

CCTP smart contract addresses for Pharos. For contract interfaces and method signatures, see [Contract Interfaces](https://developers.circle.com/cctp/references/contract-interfaces).

Full contract source code is [available on GitHub](https://github.com/circlefin/evm-cctp-contracts).

### Pacific Mainnet Contracts

#### TokenMessengerV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains#domain-identifiers) | Address                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Pharos** | 31                                                                                                    | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://pharos.socialscan.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |

#### MessageTransmitterV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains#domain-identifiers) | Address                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Pharos** | 31                                                                                                    | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://pharos.socialscan.io/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |

#### TokenMinterV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains#domain-identifiers) | Address                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Pharos** | 31                                                                                                    | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://pharos.socialscan.io/address/0xfd78EE919681417d192449715b2594ab58f5D002) |

#### MessageV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains#domain-identifiers) | Address                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Pharos** | 31                                                                                                    | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://pharos.socialscan.io/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |

### Atlantic Testnet Contracts

#### TokenMessengerV2

| Blockchain         | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains#domain-identifiers) | Address                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Pharos Testnet** | 31                                                                                                    | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://pharos-testnet.socialscan.io/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |

#### MessageTransmitterV2

| Blockchain         | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains#domain-identifiers) | Address                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Pharos Testnet** | 31                                                                                                    | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://pharos-testnet.socialscan.io/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |

#### TokenMinterV2

| Blockchain         | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains#domain-identifiers) | Address                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Pharos Testnet** | 31                                                                                                    | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://pharos-testnet.socialscan.io/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |

#### MessageV2

| Blockchain         | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains#domain-identifiers) | Address                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Pharos Testnet** | 31                                                                                                    | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://pharos-testnet.socialscan.io/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |

## Message Passing

Cross-Chain Transfer Protocol (CCTP) uses generalized message passing to facilitate the native burning and minting of USDC across supported blockchains, also known as [domains](https://developers.circle.com/cctp/cctp-supported-blockchains#cctp-supported-domains). Message passing is a three-step process:

1. An onchain component on the source domain emits a message.
2. Circle’s offchain attestation service signs the message.
3. The onchain component at the destination domain receives the message, and forwards the message body to the specified recipient.

## For Pharos

The relationship between CCTP’s onchain components and Circle’s offchain Attestation Service is illustrated below for a burn-and-mint of USDC between EVM-compatible domains:

<figure><img src="https://3298017099-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FNmFp0ycownpuaUNf2xeE%2Fuploads%2Fgit-blob-88adb19fd9106d932c803ff23a49caee5f6fb513%2Fcctp.png?alt=media" alt=""><figcaption></figcaption></figure>

On Pharos, the onchain component for crosschain burning and minting is called `TokenMessengerV2`, which is built on top of `MessageTransmitterV2`, an onchain component for generalized message passing.

In the diagram, a token depositor calls the [TokenMessengerV2#depositForBurn](https://github.com/circlefin/evm-cctp-contracts/blob/63ab1f0ac06ce0793c0bbfbb8d09816bc211386d/src/v2/TokenMessengerV2.sol#L158) function to deposit a native token (such as USDC), which delegates to the TokenMinterV2 contract to burn the token. The `TokenMessengerV2` contract then sends a message via the [MessageTransmitterV2#sendMessage](https://github.com/circlefin/evm-cctp-contracts/blob/63ab1f0ac06ce0793c0bbfbb8d09816bc211386d/src/v2/MessageTransmitterV2.sol#L143) function. After [sufficient block confirmations](https://developers.circle.com/cctp/required-block-confirmations), Circle’s offchain attestation service, Iris, signs the message. An API consumer must query this attestation and submits it onchain to the destination domain’s [MessageTransmitterV2#receiveMessage](https://github.com/circlefin/evm-cctp-contracts/blob/63ab1f0ac06ce0793c0bbfbb8d09816bc211386d/src/v2/MessageTransmitterV2.sol#L206) function.

To send an arbitrary message, directly call [MessageTransmitterV2#sendMessage](https://github.com/circlefin/evm-cctp-contracts/blob/63ab1f0ac06ce0793c0bbfbb8d09816bc211386d/src/v2/MessageTransmitterV2.sol#L143). The message recipient must implement the following methods to handle messages based on their finality threshold:

* Implement [IMessageHandlerV2#handleReceiveFinalizedMessage](https://github.com/circlefin/evm-cctp-contracts/blob/63ab1f0ac06ce0793c0bbfbb8d09816bc211386d/src/interfaces/v2/IMessageHandlerV2.sol#L35) to receive messages with `finalityThresholdExecuted` ≥ 2000.
* Implement [IMessageHandlerV2#handleReceiveUnfinalizedMessage](https://github.com/circlefin/evm-cctp-contracts/blob/63ab1f0ac06ce0793c0bbfbb8d09816bc211386d/src/interfaces/v2/IMessageHandlerV2.sol#L51) to receive messages with `finalityThresholdExecuted` < 2000.

This distinction allows the recipient to control the level of finality it requires before accepting a message.

## Message Format

### Message Header

The top-level message header format is standard for all messages passing through CCTP.

| Field                       | Offset | Solidity Type | Length (bytes) | Description                                                                                                                   |
| --------------------------- | ------ | ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `version`                   | 0      | `uint32`      | 4              | Version identifier - use 1 for CCTP                                                                                           |
| `sourceDomain`              | 4      | `uint32`      | 4              | Source domain ID                                                                                                              |
| `destinationDomain`         | 8      | `uint32`      | 4              | Destination domain ID                                                                                                         |
| `nonce`                     | 12     | `bytes32`     | 32             | Unique message nonce (see [CCTP V2 Nonces](#cctp-v2-nonces))                                                                  |
| `sender`                    | 44     | `bytes32`     | 32             | Address of MessageTransmitterV2 caller on source domain                                                                       |
| `recipient`                 | 76     | `bytes32`     | 32             | Address to handle message body on destination domain                                                                          |
| `destinationCaller`         | 108    | `bytes32`     | 32             | Address permitted to call MessageTransmitterV2 on destination domain, or bytes32(0) if message can be received by any address |
| `minFinalityThreshold`      | 140    | `uint32`      | 4              | Minimum finality threshold before allowed to attest (see [CCTP V2 Finality Thresholds](#cctp-v2-finality-thresholds))         |
| `finalityThresholdExecuted` | 144    | `uint32`      | 4              | Actual finality threshold executed from source chain (see [CCTP V2 Finality Thresholds](#cctp-v2-finality-thresholds))        |
| `messageBody`               | 148    | `bytes`       | dynamic        | App-specific message to be handled by recipient                                                                               |

#### Nonces

A CCTP nonce is a unique identifier for a message that can only be used once on the destination domain. Circle assigns CCTP nonces offchain. The nonce for each message in a transaction can be queried through the [`GET /v2/messages`](https://developers.circle.com/api-reference/cctp/all/get-messages-v2) endpoint, using the transaction hash as a query parameter.

{% hint style="info" %}
**Why `bytes32` type for addresses**

CCTP is built to support EVM chains, which use 20 byte addresses, and non-EVM chains, many of which use 32 byte addresses. Circle provides a [`Message.sol` library](https://github.com/circlefin/evm-cctp-contracts/blob/40111601620071988e94e39274c8f48d6f406d6d/src/messages/Message.sol#L145-L157) as a reference implementation for converting between address and `bytes32` in Solidity.
{% endhint %}

### Message body

The message format includes a dynamically sized `messageBody` field, used for application-specific messages. For example, `TokenMessengerV2` defines a [BurnMessageV2](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/messages/v2/BurnMessageV2.sol) with data related to crosschain transfers.

| Field             | Offset | Solidity Type | Length (bytes) | Description                                                                                                                                                                                                                                                                                            |
| ----------------- | ------ | ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`         | 0      | `uint32`      | 4              | Version identifier - use 1 for CCTP                                                                                                                                                                                                                                                                    |
| `burnToken`       | 4      | `bytes32`     | 32             | Address of burned token on source domain                                                                                                                                                                                                                                                               |
| `mintRecipient`   | 36     | `bytes32`     | 32             | Address to receive minted tokens on destination domain                                                                                                                                                                                                                                                 |
| `amount`          | 68     | `uint256`     | 32             | Amount of burned tokens                                                                                                                                                                                                                                                                                |
| `messageSender`   | 100    | `bytes32`     | 32             | Address of caller of `depositForBurn` (or `depositForBurnWithCaller`) on source domain                                                                                                                                                                                                                 |
| `maxFee`          | 132    | `uint256`     | 32             | Maximum fee to pay on the destination domain, specified in units of `burnToken`                                                                                                                                                                                                                        |
| `feeExecuted`     | 164    | `uint256`     | 32             | Actual fee charged on the destination domain, specified in units of `burnToken` (capped by `maxFee`)                                                                                                                                                                                                   |
| `expirationBlock` | 196    | `uint256`     | 32             | An expiration block 24 hours in the future is encoded in the message before signing by attestation service, and is respected on the destination chain. If the burn expires, it must be re-signed. Expiration acts as a safety mechanism against problems with finalization, such as a stuck sequencer. |
| `hookData`        | 228    | `bytes`       | dynamic        | Arbitrary data to be included in the `depositForBurn` on source domain and to be executed on destination domain                                                                                                                                                                                        |

{% hint style="info" %}
**`expirationBlock` on ARB-stack blockchains**

For ARB-stack destination blockchains (Arbitrum, EDGE, and Plume), the `expirationBlock` is an Ethereum (L1) block number, not the L2 block number. ARB-stack blockchains track blocks internally using the parent blockchain (Ethereum). When validating expiration for these blockchains, compare the `expirationBlock` value against the current Ethereum block number, not the L2 block number.
{% endhint %}

## API hosts and endpoints

CCTP provides a set of API hosts and endpoints to manage messages, attestations, and transaction details for your crosschain USDC transfers.

### API service hosts

| Environment | URL                                   |
| ----------- | ------------------------------------- |
| **Testnet** | `https://iris-api-sandbox.circle.com` |
| **Mainnet** | `https://iris-api.circle.com`         |

{% hint style="info" %}
**API Service Rate Limit**

The CCTP API service rate limit is 35 requests per second. If you exceed 35 requests per second, the service blocks all API requests for the next 5 minutes and returns an HTTP 429 response.
{% endhint %}

### API endpoints

CCTP endpoints enable advanced capabilities such as fetching attestations for **Standard Transfer** or **Fast Transfer** burn events, verifying public keys across versions, accessing transaction details, querying fast transfer allowances and fees, and initiating re-attestation processes. Below is an overview of the CCTP public endpoints. Click on any endpoint for its API reference.

| Endpoint                                                                                                                                           | Description                                                                                                      | Use Case                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`GET /v2/publicKeys`](https://github.com/PharosNetwork/docs/blob/main/api-reference/cctp/all/get-public-keys-v2/README.md)                        | Returns public keys for validating attestations across all supported CCTP versions.                              | Retrieve public keys to verify attestation authenticity for crosschain transactions.           |
| [`GET /v2/messages`](https://github.com/PharosNetwork/docs/blob/main/api-reference/cctp/all/get-messages-v2/README.md)                             | Retrieves messages and attestations for a given transaction or nonce, supporting messages for all CCTP versions. | Fetch attestation status and transaction details.                                              |
| [`POST /v2/reattest`](https://github.com/PharosNetwork/docs/blob/main/api-reference/cctp/all/reattest-message/README.md)                           | Re-attests a soft finality V2 message to achieve finality or revive expired Fast Transfer burns.                 | Handle edge cases requiring updated attestations or finalize transactions with stricter rules. |
| [`GET /v2/fastBurn/USDC/allowance`](https://github.com/PharosNetwork/docs/blob/main/api-reference/cctp/all/get-fast-burn-usdc-allowance/README.md) | Retrieves the current USDC Fast Transfer allowance remaining.                                                    | Monitor available allowance for Fast Transfer burns in real-time.                              |
| [`GET /v2/burn/USDC/fees`](https://github.com/PharosNetwork/docs/blob/main/api-reference/cctp/all/get-burn-usdc-fees/README.md)                    | Returns the fees for USDC transfers between specified source and destination domains.                            | Calculate transaction costs before initiating a Fast or Standard Transfer.                     |

{% hint style="info" %}
**Deprecated endpoint**

The endpoint `/v2/fastBurn/USDC/fees` is deprecated. Use [`/v2/burn/USDC/fees`](https://github.com/PharosNetwork/docs/blob/main/api-reference/cctp/all/get-burn-usdc-fees/README.md) instead to retrieve both Fast and Standard Transfer fees.

**Note:** This deprecation does **not** affect [`/v2/fastBurn/USDC/allowance`](https://github.com/PharosNetwork/docs/blob/main/api-reference/cctp/all/get-fast-burn-usdc-allowance/README.md) (see preceding table), which remains active and valid.
{% endhint %}

## Finality thresholds

CCTP has the concept of a finality threshold, which is a chain-agnostic representation of the confirmation level required before an attestation is issued. This allows integrators to specify how many confirmations are needed based on their risk tolerance or use case.

In CCTP, each message specifies a `minFinalityThreshold`. This threshold indicates the minimum level of confirmation required for Circle's attestation service (Iris) to attest to the message. Iris will not attest to a message at a confirmation level below the specified minimum threshold. This allows applications to enforce a desired level of finality before acting on an attestation on the destination chain.

### Defined finality thresholds

CCTP V2 defines the following finality thresholds:

| Finality Threshold | Value |
| ------------------ | ----- |
| **Confirmed**      | 1000  |
| **Finalized**      | 2000  |

### Messages and finality

* Messages with a `minFinalityThreshold` of **1000** or lower are considered **Fast** messages. These messages are eligible for fast attestation at the *confirmed* level by Iris.
* Messages with a `minFinalityThreshold` of **2000** are considered **Standard** messages. These messages are attested to at the *finalized* level by Iris.

{% hint style="info" %}
Only two finality thresholds are supported. Any `minFinalityThreshold` value below **1000** is treated as **1000**, and any value above **1000** is treated as **2000**.
{% endhint %}

## Fees

For information about CCTP transfer fees, including fee tables by blockchain, the `maxFee` parameter, and Standard Transfer fee switch support, see [CCTP Fees](https://developers.circle.com/cctp/concepts/fees).

## Hooks

Hooks in CCTP V2 are metadata that can be attached to a burn message, allowing integrators to execute custom logic at the destination chain. Hook execution is left entirely to the integrator, offering maximum flexibility and enabling broader crosschain compatibility without altering the core CCTP protocol.

### Design overview

CCTP does not implement hook execution in the core protocol. Instead, hooks are treated as opaque metadata passed along with the burn message. This design allows integrators to define and control how hooks are processed on the destination chain, based on their own infrastructure and trust model.

### Key benefits

* **Maximum flexibility for integrators**
  * Determine execution timing: pre-mint or post-mint
  * Implement custom recovery or error-handling strategies if hook execution fails
  * Choose any execution environment (EVM or non-EVM); even non-EVM chains can support Hooks as data passed into a function call.
* **Improved Compliance and Security Separation**
  * **Compliance**: By delegating hook execution to the integrator, the protocol maintains a clear boundary between CCTP's core message-passing capabilities and application-specific logic. This modular approach helps integrators meet their own compliance requirements with greater flexibility.
  * **Security**: By keeping hook execution outside the core protocol, CCTP maintains a smaller and more focused security surface, while allowing integrators to manage their own execution environments independently.
