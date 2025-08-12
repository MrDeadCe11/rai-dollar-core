const testHelpers = require("../utils/testHelpers.js")
const DefaultPool = artifacts.require("./DefaultPool.sol")
const NonPayable = artifacts.require('NonPayable.sol')

const th = testHelpers.TestHelper
const dec = th.dec

contract('DefaultPool', async accounts => {
  let defaultPool
  let nonPayable
  let mockActivePool
  let mockTroveManager
  let mockCollateralToken
  let [owner] = accounts

  beforeEach('Deploy contracts', async () => {
    defaultPool = await DefaultPool.new()
    nonPayable = await NonPayable.new()
    mockLiquidations = await NonPayable.new()
    mockTroveManager = await NonPayable.new()
    mockActivePool = await NonPayable.new()
    mockCollateralToken = await NonPayable.new()

    await defaultPool.setAddresses(mockLiquidations.address, mockTroveManager.address, mockActivePool.address, mockCollateralToken.address)
  })

  it.skip('sendCollateralToActivePool(): fails if receiver cannot receive Collateral', async () => {
    const amount = dec(1, 'ether')

    // start pool with `amount`
    //await web3.eth.sendTransaction({ to: defaultPool.address, from: owner, value: amount })
    const tx = await mockActivePool.forward(defaultPool.address, '0x', { from: owner, value: amount })
    assert.isTrue(tx.receipt.status)

    // try to send collateral from pool to non-payable
    //await th.assertRevert(defaultPool.sendCollateralToActivePool(amount, { from: owner }), 'DefaultPool: sending Collateral failed')
    const sendCollateralData = th.getTransactionData('sendCollateralToActivePool(uint256)', [web3.utils.toHex(amount)])
    await th.assertRevert(mockTroveManager.forward(defaultPool.address, sendETHData, { from: owner }), 'DefaultPool: sending ETH failed')
  })
})

contract('Reset chain state', async accounts => { })
