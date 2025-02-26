$(document).ready(function() {
    /* $("#fuel_type").autocomplete({
      source: function(request, response) {
        $.ajax({
          url: '/api-get-fuel-types', 
          type: 'GET',
          data: { term: request.term }, 
          dataType: 'json',
          success: function(data) {
            response(data.fuelTypes); 
          }
        });
      }
    }); */
    $("#fuel_type").autocomplete(['tipo 1', 'tipo 2', 'tipo 3']);
  });