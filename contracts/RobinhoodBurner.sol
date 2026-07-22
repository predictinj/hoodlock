// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
   RobinhoodBurner — a public burn registry for Robinhood Chain, companion to
   RobinhoodLocker.

   Anyone can burn any ERC-20 forever. Tokens are pulled straight from the
   caller to the dead address (0x…dEaD) in a single hop — they never rest in
   this contract, so there is NO admin path to them, ever. Each burn is
   recorded with an id and emits an event, giving every burn the same
   shareable on-chain proof as a lock. Core guarantees:
     • Burns are irreversible by construction: nothing can move tokens out of
       the dead address.
     • Fee-on-transfer tokens are handled by recording the amount the dead
       address actually received.
     • Reentrancy-guarded.
   The admin can change ONLY the flat fee, the fee collector, and the admin key.
*/

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract RobinhoodBurner {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct Burn {
        address burner;
        address token;
        uint256 amount;
        uint256 timestamp;
    }

    uint256 public nextBurnId;
    mapping(uint256 => Burn) public burns;
    mapping(address => uint256[]) private _byBurner;
    mapping(address => uint256[]) private _byToken;
    mapping(address => uint256) public totalBurnedOf;   // token => cumulative amount burned here

    uint256 public fee;           // flat ETH fee charged per burn
    address public feeCollector;  // receives the fees
    address public admin;         // may change fee / feeCollector / admin ONLY

    event Burned(uint256 indexed id, address indexed burner, address indexed token, uint256 amount);
    event FeeChanged(uint256 fee);

    modifier onlyAdmin() { require(msg.sender == admin, "not admin"); _; }

    uint256 private _guard = 1;
    modifier nonReentrant() { require(_guard == 1, "reentrant"); _guard = 2; _; _guard = 1; }

    constructor(uint256 _fee, address _feeCollector) {
        admin = msg.sender;
        fee = _fee;
        feeCollector = _feeCollector == address(0) ? msg.sender : _feeCollector;
    }

    /// Burn `amount` of `token` forever. Requires prior approve() and msg.value >= fee.
    function burn(address token, uint256 amount) external payable nonReentrant returns (uint256 id) {
        require(msg.value >= fee, "fee too low");
        require(amount > 0, "amount = 0");
        require(token != address(0), "token = 0");

        uint256 balBefore = IERC20(token).balanceOf(DEAD);
        require(IERC20(token).transferFrom(msg.sender, DEAD, amount), "transferFrom failed");
        uint256 received = IERC20(token).balanceOf(DEAD) - balBefore;
        require(received > 0, "nothing burned");

        id = nextBurnId++;
        burns[id] = Burn({ burner: msg.sender, token: token, amount: received, timestamp: block.timestamp });
        _byBurner[msg.sender].push(id);
        _byToken[token].push(id);
        totalBurnedOf[token] += received;

        if (fee > 0) { (bool okFee, ) = feeCollector.call{value: fee}(""); require(okFee, "fee transfer failed"); }
        if (msg.value > fee) { (bool okRef, ) = msg.sender.call{value: msg.value - fee}(""); require(okRef, "refund failed"); }

        emit Burned(id, msg.sender, token, received);
    }

    // ---- views ----
    function getBurn(uint256 id) external view returns (Burn memory) { return burns[id]; }
    function burnsByBurner(address b) external view returns (uint256[] memory) { return _byBurner[b]; }
    function burnsByToken(address t) external view returns (uint256[] memory) { return _byToken[t]; }
    function totalBurns() external view returns (uint256) { return nextBurnId; }

    // ---- admin: fee config ONLY (tokens never touch this contract) ----
    function setFee(uint256 _fee) external onlyAdmin { fee = _fee; emit FeeChanged(_fee); }
    function setFeeCollector(address c) external onlyAdmin { require(c != address(0), "zero"); feeCollector = c; }
    function setAdmin(address a) external onlyAdmin { require(a != address(0), "zero"); admin = a; }
}
