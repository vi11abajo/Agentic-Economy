// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ProsperionGate} from "../src/ProsperionGate.sol";

// Deploys the gate with Prosper's factory and market beacon (from api.pros-per.xyz/api/v1/deployment, checked on
// chain by protocol.ts). The deployer has no special rights afterwards: there is no owner.
//   forge script script/Deploy.s.sol --rpc-url https://rpc.pharos.xyz --broadcast --interactive
contract Deploy is Script {
    function run() external returns (ProsperionGate gate) {
        address factory = vm.envOr("PROSPER_FACTORY", 0xEfdbb0eA7647B0e21AEf7A3b7a5D6A632c3116C8);
        address beacon = vm.envOr("PROSPER_MARKET_BEACON", 0x30BeBe432fF53c9B6ED28Dd9DAf125902CbABB56);
        vm.startBroadcast();
        gate = new ProsperionGate(factory, beacon);
        vm.stopBroadcast();
        console.log("ProsperionGate", address(gate));
    }
}
