// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * RevenueSplitter — the 50/50 fee split, enforced by code instead of by hand.
 *
 * The HoodLock contracts pay their fees to a single feeCollector. Pointing
 * that collector here makes the revenue share self-executing: half of every
 * fee belongs to the team wallet, half to the operations wallet that runs the
 * weekly $LOCK buyback and drop. Both payees are immutable; there is no
 * admin, no upgrade path, and no function that can move money anywhere else.
 *
 * Threat model:
 *  - K1  The locker and burner PUSH their fee inline with the user's lock/burn
 *        transaction and revert the whole action if the transfer fails. The
 *        receive() below is therefore empty and can never revert: a splitter
 *        that could reject a fee would brick locking itself.
 *  - K2  Funds can only leave through release(), and release() can only send
 *        to the two immutable payees, always splitting the full balance. A
 *        third party calling release() can rush the split, never redirect it.
 *  - K3  pull() takes an arbitrary address but invokes only withdrawFees(),
 *        because the vesting and airdrop contracts hold fees until their
 *        collector (this contract) asks. A malicious "source" gains nothing:
 *        whatever it does, money still only exits 50/50 via release(), which
 *        is reentrancy-guarded.
 *  - K4  Odd wei goes to the team side, so ops can never be overpaid.
 *  - K5  If either payee ever refuses ETH (they are EOAs, so only by chain
 *        catastrophe), release() reverts atomically and funds simply wait.
 */
interface IFeeSource {
    function withdrawFees() external;
}

contract RevenueSplitter {
    address public immutable team;
    address public immutable ops;

    uint256 private _entered = 1;

    event Released(uint256 toOps, uint256 toTeam);

    constructor(address _team, address _ops) {
        require(_team != address(0) && _ops != address(0), "zero payee");
        require(_team != _ops, "same payee");
        team = _team;
        ops = _ops;
    }

    /// Fee pushes land here mid-transaction (K1). Accept, nothing else.
    receive() external payable {}

    /// Split the full balance between the two fixed payees. Permissionless:
    /// the caller chooses only WHEN, never WHERE (K2).
    function release() public {
        require(_entered == 1, "reentrant");
        _entered = 2;
        uint256 bal = address(this).balance;
        if (bal > 0) {
            uint256 toOps = bal / 2; // odd wei favors the team (K4)
            (bool a, ) = ops.call{value: toOps}("");
            require(a, "ops send failed");
            (bool b, ) = team.call{value: bal - toOps}("");
            require(b, "team send failed");
            emit Released(toOps, bal - toOps);
        }
        _entered = 1;
    }

    /// Drain a pull-style fee source (withdrawFees() pays its collector, i.e.
    /// this contract), then split what arrived (K3).
    function pull(address source) external {
        IFeeSource(source).withdrawFees();
        release();
    }
}
