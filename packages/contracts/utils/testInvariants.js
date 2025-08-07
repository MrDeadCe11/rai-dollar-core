const testHelpers = require("../utils/testHelpers.js")
const th = testHelpers.TestHelper
const toBN = th.toBN
const BN = require('bn.js')

class TestInvariant {

  static async debtEqualsSupply(contracts) {

    // a few tests use unprotected mints, which are not from debt
    // so need to subtract from totalSupply
    const unprotectedSupply = await contracts.lusdToken.unprotectedSupply()

    const debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate())
    const supply = (await contracts.lusdToken.totalSupply()).sub(unprotectedSupply)

    // system allows slightly more supply than debt due to rounding
    // this gap is corrected with each drip()
    return (supply.sub(debt).lte(toBN('3')) || debt.eq(toBN('0')))

  }

  static async SpBalanceEqualsErc20Balance(contracts) {
    //ERC20 balance  ==  totalLUSDDeposits · P / 1e18   ± 1 wei
    const totalDeposits = await contracts.stabilityPool.getTotalLUSDDeposits()
    const balance = await contracts.lusdToken.balanceOf(contracts.stabilityPool.address)
    if (totalDeposits > balance) {
        return (totalDeposits - balance).eq(1)
    } else if (totalDeposits < balance) {
        return (balance - totalDeposits).eq(1)
    }
    return true
  }



}
module.exports = {
  TestInvariant
}
