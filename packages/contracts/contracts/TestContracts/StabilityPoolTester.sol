// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../StabilityPool.sol";

contract StabilityPoolTester is StabilityPool {
    
    function setCurrentScale(uint _currentScale) external {
        currentScale = _currentScale;
    }

    function increaseTotalLUSDDeposits(uint _amount) external {
        totalLUSDDeposits += _amount;
    }
    function decreaseTotalLUSDDeposits(uint _amount) external {
        totalLUSDDeposits -= _amount;
    }

    function resetTotalLUSDDeposits() external {
        totalLUSDDeposits = 0;
    }

    function setOffset(uint _baseDebtToOffset, uint _baseNDebtToOffset, uint _baseCollToAdd,
                    uint _shieldedDebtToOffset, uint _shieldedNDebtToOffset, uint _shieldedCollToAdd) external {

        // Dont need drip() here since it's called upstream in liquidations
        _mintPendingDeposits();

        uint totalLUSD = totalLUSDDeposits; // cached to save an SLOAD
        if (totalLUSD == 0 || (_baseDebtToOffset == 0 && _shieldedDebtToOffset == 0)) { return; }

        _triggerLQTYIssuance(communityIssuance);

        uint totalDebtToOffset = _baseDebtToOffset.add(_shieldedDebtToOffset);
        uint totalCollToAdd = _baseCollToAdd.add(_shieldedCollToAdd);

        (uint collateralGainPerUnitStaked,
            uint LUSDLossPerUnitStaked) = _computeRewardsPerUnitStaked(totalCollToAdd, totalDebtToOffset, totalLUSD);

        _updateRewardSumAndProduct(collateralGainPerUnitStaked, LUSDLossPerUnitStaked);  // updates S and P
        _moveOffsetCollAndDebt(totalDebtToOffset, _baseCollToAdd,  _baseNDebtToOffset,
                              _shieldedCollToAdd, _shieldedNDebtToOffset);

        emit Offset(_baseCollToAdd.add(_shieldedCollToAdd), totalDebtToOffset,
                    totalLUSD, LUSDLossPerUnitStaked, collateralGainPerUnitStaked);

    }


}
