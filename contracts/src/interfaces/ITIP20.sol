// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal TIP-20 interface: the subset of Tempo's stablecoin token
/// standard that ChannelManager actually calls. TIP-20 is ERC-20-compatible
/// (see https://tempo.xyz/developers/docs/protocol/tip20/spec) but is always
/// 6 decimals and, on Tempo, is the only way to move value — there is no
/// native gas token, so `transfer`/`transferFrom` are the sole fund-movement
/// primitives available to this contract.
interface ITIP20 {
    function decimals() external pure returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
