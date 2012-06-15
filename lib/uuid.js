/**
 * uuid generator
 * --------------
 *
 * @exports {Function} uuid generator function
 */

 /**
  * @param [len] {Number} Length of the ID to generate.
  * @return {String} A unique alphanumeric string.
  */
 module.exports = function(len) {
  len = (len || 8);
  var ret = ''
    , choices = 'ABCDEFGHIJKLMNOPQRSTUVWYXZabcdefghijklmnopqrstuvwyxz0123456789'
    , range = choices.length - 1
    , len_left = len
    ;
  while (len_left--) {
    ret += choices[Math.round(Math.random() * range)];
  }
  return ret;
};