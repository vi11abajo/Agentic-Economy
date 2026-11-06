// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract Runner {
    function run(address[] calldata t, bytes[] calldata d) external returns (bytes[] memory out) {
        out = new bytes[](t.length);
        for (uint i; i < t.length; i++) {
            (bool ok, bytes memory r) = t[i].call(d[i]);
            if (!ok) { assembly { revert(add(r, 32), mload(r)) } }
            out[i] = r;
        }
    }
}
