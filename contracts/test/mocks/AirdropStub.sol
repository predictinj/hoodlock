// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StandardToken} from "./Tokens.sol";

/**
 * The parts of RobinhoodAirdrop that LockRoundManager touches, with the one
 * rule that matters reproduced faithfully: sweep() refuses before endTime and
 * pays the CREATOR. If that were relaxed the manager's tests would prove
 * nothing about the real thing.
 */
contract AirdropStub {
    struct Drop {
        address token;
        address creator;
        uint256 remaining;
        uint64 endTime;
        bool swept;
    }

    mapping(uint256 => Drop) public drops;
    uint256 public nextId;
    uint256 public feePerCreate;

    function setFee(uint256 f) external { feePerCreate = f; }
    function quote(uint32) external view returns (uint256) { return feePerCreate; }

    function create(
        address token,
        bytes32,
        uint256 total,
        uint32,
        uint64 endTime,
        string calldata
    ) external payable returns (uint256 id) {
        require(msg.value == feePerCreate, "bad fee");
        StandardToken(token).transferFrom(msg.sender, address(this), total);
        id = nextId++;
        drops[id] = Drop({token: token, creator: msg.sender, remaining: total, endTime: endTime, swept: false});
    }

    /// A claimant taking their share, so `remaining` moves like the real one.
    function claimTo(uint256 id, address to, uint256 amount) external {
        Drop storage d = drops[id];
        require(block.timestamp < d.endTime, "closed");
        d.remaining -= amount;
        StandardToken(d.token).transfer(to, amount);
    }

    function sweep(uint256 id) external {
        Drop storage d = drops[id];
        require(msg.sender == d.creator, "not creator");
        require(block.timestamp >= d.endTime, "not closed yet");
        require(!d.swept, "already swept");
        uint256 amount = d.remaining;
        require(amount > 0, "nothing left");
        d.swept = true;
        d.remaining = 0;
        StandardToken(d.token).transfer(d.creator, amount);
    }
}
