- 为该项目增加查询个人所有提交、个人发布的所有征集的api，并且教师前端的显示改为优先显示自己发布的征集中未回复的提交
- 为班级增加一个新增征集模式的api（管理员）：
{
    auth:str,
    modeName:str,
    extendModes:Array<str>
}
返回：success/fail
例如：
{
    auth:"example auth",
    modeName:"maths multiple-choise homework",
    extendModes:["homework","answer sheet"]
}
- 把小程序端如删除提交/回复/征集、重置密钥、删除密钥、解绑密钥等等敏感操作显示为弹窗;弹窗的ui要求：居中显示，不可划走且必须确认或取消;显示所操作对象的信息;如有必要提示输入密码。
- 前端保持与后端的同步