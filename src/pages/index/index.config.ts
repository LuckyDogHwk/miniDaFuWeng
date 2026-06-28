export default typeof definePageConfig === 'function'
  ? definePageConfig({
      navigationStyle: 'custom',
      navigationBarTitleText: '',
      pageOrientation: 'landscape',
      enableShareAppMessage: true,
    })
  : {
      navigationStyle: 'custom',
      navigationBarTitleText: '',
      pageOrientation: 'landscape',
      enableShareAppMessage: true,
    }
