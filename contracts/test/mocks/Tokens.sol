// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal ERC-20 used as the honest baseline in tests.
contract StandardToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint256 supply) {
        name = _name;
        symbol = _symbol;
        _mint(msg.sender, supply);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal virtual returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Takes a 1% cut on every transfer (burned) — tests received-amount accounting.
contract FeeOnTransferToken is StandardToken {
    constructor(uint256 supply) StandardToken("FoT", "FOT", supply) {}

    function _transfer(address from, address to, uint256 amount) internal override returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 cut = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - cut;
        totalSupply -= cut;
        return true;
    }
}

/// USDT-style: transfer/transferFrom return NOTHING. Breaks raw require(transfer(...)).
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 supply) { balanceOf[msg.sender] = supply; }

    function approve(address spender, uint256 amount) external { allowance[msg.sender][spender] = amount; }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Returns false instead of reverting — must be treated as failure.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 supply) { balanceOf[msg.sender] = supply; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}

interface IVestingLike {
    function claim(uint256 id) external;
}

/// Attempts to re-enter claim() from inside transfer(); swallows the revert so
/// the outer transfer still succeeds. Proves the guard prevents double-claims.
contract ReentrantToken is StandardToken {
    IVestingLike public vesting;
    uint256 public attackId;
    bool public armed;

    constructor(uint256 supply) StandardToken("EVIL", "EVIL", supply) {}

    function arm(address _vesting, uint256 _id) external {
        vesting = IVestingLike(_vesting);
        attackId = _id;
        armed = true;
    }

    function _transfer(address from, address to, uint256 amount) internal override returns (bool) {
        bool ok = super._transfer(from, to, amount);
        if (armed) {
            armed = false; // one shot to avoid infinite recursion
            try vesting.claim(attackId) {} catch {}
        }
        return ok;
    }
}

/// Reverts on receiving ETH — used as a hostile feeCollector.
contract RevertingCollector {
    receive() external payable { revert("no thanks"); }
}
