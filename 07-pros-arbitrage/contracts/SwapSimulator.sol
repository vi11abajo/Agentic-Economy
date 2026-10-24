// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

// Never deployed. prosArbitrage puts this code at a throwaway address with an eth_call state override, gives
// that address the input tokens the same way, and calls exactIn. The swap runs on the real Faroswap V3 pool at
// the current state, so the result is exactly what the pool would pay right now: fee and price impact included.

interface IUniswapV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract SwapSimulator {
    uint160 internal constant MIN_SQRT_RATIO_PLUS_1 = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_1 = 1461446703485210103287273052203988822378723970341;

    /// Swaps all of amountIn and returns what came out, and the gas the pool's swap used.
    function exactIn(address pool, bool zeroForOne, uint256 amountIn) external returns (uint256 amountOut, uint256 gasUsed) {
        uint256 before = gasleft();
        (int256 a0, int256 a1) = IUniswapV3Pool(pool).swap(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO_PLUS_1 : MAX_SQRT_RATIO_MINUS_1, abi.encode(pool)
        );
        gasUsed = before - gasleft();
        amountOut = uint256(-(zeroForOne ? a1 : a0));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "not the pool");
        if (amount0Delta > 0) IERC20(IUniswapV3Pool(pool).token0()).transfer(pool, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(IUniswapV3Pool(pool).token1()).transfer(pool, uint256(amount1Delta));
    }
}
